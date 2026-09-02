import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import {
  createHotPathIndexes,
  HOT_PATH_INDEXES,
} from './hot-path-indexes.migration';

/**
 * B6 / DB-008 + DB-010.
 *
 * The plan-verification block is the point of this file: it seeds enough
 * documents that a COLLSCAN and an IXSCAN are distinguishable, records
 * executionStats before the migration, runs it, and records them again. A
 * migration that creates indexes nothing uses would pass every other check
 * here.
 */

describe('hot-path indexes (integration)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  }, 60_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    const collections = await connection.db!.collections();
    for (const c of collections) await c.drop().catch(() => undefined);
  });

  const indexNames = async (collection: string): Promise<string[]> => {
    const rows = await connection
      .collection(collection)
      .listIndexes()
      .toArray();
    return rows.map((r) => r.name as string);
  };

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  it('HP: creates every planned index on a fresh database', async () => {
    const result = await createHotPathIndexes(connection);

    expect(result.created).toBe(HOT_PATH_INDEXES.length);
    expect(result.conflicts).toBe(0);

    for (const planned of HOT_PATH_INDEXES) {
      await expect(indexNames(planned.collection)).resolves.toContain(
        planned.name,
      );
    }
  });

  it('HP: created indexes carry the exact planned key', async () => {
    await createHotPathIndexes(connection);

    for (const planned of HOT_PATH_INDEXES) {
      const rows = await connection
        .collection(planned.collection)
        .listIndexes()
        .toArray();
      const found = rows.find((r) => r.name === planned.name);
      expect(found?.key).toEqual(planned.key);
    }
  });

  // -------------------------------------------------------------------------
  // Idempotency (DB-008)
  // -------------------------------------------------------------------------

  it('HP: a second run creates nothing and throws nothing', async () => {
    await createHotPathIndexes(connection);
    const second = await createHotPathIndexes(connection);

    expect(second.created).toBe(0);
    expect(second.skipped).toBe(HOT_PATH_INDEXES.length);
    expect(second.conflicts).toBe(0);
  });

  it('HP: a third run is still stable', async () => {
    await createHotPathIndexes(connection);
    await createHotPathIndexes(connection);
    const third = await createHotPathIndexes(connection);
    expect(third.skipped).toBe(HOT_PATH_INDEXES.length);
  });

  it('EC: a partially-applied run completes the remainder', async () => {
    // Interrupted migration: one index exists, the rest do not.
    const [first] = HOT_PATH_INDEXES;
    await connection
      .collection(first.collection)
      .createIndex(first.key, { name: first.name });

    const result = await createHotPathIndexes(connection);
    expect(result.created).toBe(HOT_PATH_INDEXES.length - 1);
    expect(result.skipped).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Not destructive
  // -------------------------------------------------------------------------

  it('EC: an unrelated pre-existing index survives the run', async () => {
    await connection
      .collection('products')
      .createIndex({ productCategory: 1 }, { name: 'someone_elses_index' });

    await createHotPathIndexes(connection);

    await expect(indexNames('products')).resolves.toEqual(
      expect.arrayContaining(['someone_elses_index', 'inventoryId_isArchived']),
    );
  });

  it('EC: a name collision with a different key is reported, not forced', async () => {
    await connection
      .collection('ratings')
      .createIndex(
        { customerUid: 1 },
        { name: 'branchId_isRemoved_createdAt' },
      );

    const result = await createHotPathIndexes(connection);

    expect(result.conflicts).toBe(1);
    const row = result.rows.find((r) => r.outcome === 'conflict');
    expect(row?.collection).toBe('ratings');
    expect(row?.existingKey).toEqual({ customerUid: 1 });

    // Left exactly as it was — the migration does not drop what it did not make.
    const rows = await connection.collection('ratings').listIndexes().toArray();
    const existing = rows.find(
      (r) => r.name === 'branchId_isRemoved_createdAt',
    );
    expect(existing?.key).toEqual({ customerUid: 1 });
  });

  it('EC: an equivalent index under another name is not duplicated', async () => {
    // Same key, different name — already covers the query, so creating a
    // second one would only cost writes.
    await connection
      .collection('inventory')
      .createIndex(
        { uid: 1, branchId: 1, isArchived: 1 },
        { name: 'legacy_inventory_lookup' },
      );

    const result = await createHotPathIndexes(connection);

    const names = await indexNames('inventory');
    expect(names).toContain('legacy_inventory_lookup');
    expect(names).not.toContain('uid_branchId_isArchived');
    expect(result.rows.find((r) => r.collection === 'inventory')?.outcome).toBe(
      'skipped',
    );
  });

  // -------------------------------------------------------------------------
  // Hygiene (DB-007)
  // -------------------------------------------------------------------------

  it('HP: no two planned indexes share a name within a collection', () => {
    const seen = new Set<string>();
    for (const ix of HOT_PATH_INDEXES) {
      const key = `${ix.collection}.${ix.name}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('HP: no planned index is a redundant prefix of another', () => {
    // {a:1} is redundant when {a:1,b:1} exists — Mongo can use the longer one
    // for the shorter query. This guards against that creeping in later.
    for (const a of HOT_PATH_INDEXES) {
      for (const b of HOT_PATH_INDEXES) {
        if (a === b || a.collection !== b.collection) continue;
        const ak = Object.keys(a.key);
        const bk = Object.keys(b.key);
        if (ak.length >= bk.length) continue;
        const isPrefix = ak.every((k, i) => bk[i] === k);
        expect(isPrefix).toBe(false);
      }
    }
  });

  // -------------------------------------------------------------------------
  // DB-010 — query plans actually change
  // -------------------------------------------------------------------------

  describe('query plans (DB-010)', () => {
    const ORDER_ID = '000000000000000000000abc';
    const BRANCH_ID = '000000000000000000000b01';

    /** Enough rows that COLLSCAN and IXSCAN are unambiguous. */
    const seed = async () => {
      const txs = Array.from({ length: 2000 }, (_, i) => ({
        orderId: i === 0 ? ORDER_ID : `order-${i}`,
        createdAt: new Date(Date.now() - i * 1000),
        totalAmount: 100,
      }));
      await connection.collection('pos_transactions').insertMany(txs);

      const ratings = Array.from({ length: 2000 }, (_, i) => ({
        branchId: i % 500 === 0 ? BRANCH_ID : `branch-${i}`,
        isRemoved: false,
        overallScore: (i % 5) + 1,
        createdAt: new Date(Date.now() - i * 1000),
      }));
      await connection.collection('ratings').insertMany(ratings);
    };

    const explainTx = () =>
      connection
        .collection('pos_transactions')
        .find({ orderId: ORDER_ID })
        .sort({ createdAt: 1 })
        .explain('executionStats') as Promise<Record<string, any>>;

    const explainRatings = () =>
      connection
        .collection('ratings')
        .find({ branchId: BRANCH_ID, isRemoved: false })
        .sort({ createdAt: -1 })
        .explain('executionStats') as Promise<Record<string, any>>;

    const stage = (plan: Record<string, any>): string => {
      let node = plan.queryPlanner?.winningPlan;
      while (node) {
        if (node.stage === 'IXSCAN' || node.stage === 'COLLSCAN')
          return node.stage;
        node = node.inputStage ?? node.queryPlan ?? node.inputStages?.[0];
      }
      return 'UNKNOWN';
    };

    it('HP: pos_transactions goes from COLLSCAN to IXSCAN', async () => {
      await seed();

      const before = await explainTx();
      expect(stage(before)).toBe('COLLSCAN');
      expect(before.executionStats.totalDocsExamined).toBe(2000);

      await createHotPathIndexes(connection);

      const after = await explainTx();
      expect(stage(after)).toBe('IXSCAN');
      // The whole point: one matching row, one document touched.
      expect(after.executionStats.totalDocsExamined).toBe(1);
      expect(after.executionStats.totalDocsExamined).toBeLessThan(
        before.executionStats.totalDocsExamined,
      );
    }, 60_000);

    it('HP: the index chosen for pos_transactions is the one we created', async () => {
      await seed();
      await createHotPathIndexes(connection);

      const after = await explainTx();
      expect(JSON.stringify(after.queryPlanner.winningPlan)).toContain(
        'orderId_createdAt',
      );
    }, 60_000);

    it('HP: ratings provider list goes from COLLSCAN to IXSCAN', async () => {
      await seed();

      const before = await explainRatings();
      expect(stage(before)).toBe('COLLSCAN');

      await createHotPathIndexes(connection);

      const after = await explainRatings();
      expect(stage(after)).toBe('IXSCAN');
      expect(after.executionStats.totalDocsExamined).toBeLessThan(
        before.executionStats.totalDocsExamined,
      );
    }, 60_000);

    it('HP: the ratings sort is served by the index, not an in-memory SORT', async () => {
      // createdAt is the trailing key precisely so the sort comes for free.
      await seed();
      await createHotPathIndexes(connection);

      const after = await explainRatings();
      expect(JSON.stringify(after.queryPlanner.winningPlan)).not.toContain(
        '"stage":"SORT"',
      );
    }, 60_000);
  });
});
