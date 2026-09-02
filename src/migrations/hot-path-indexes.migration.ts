import type { Connection } from 'mongoose';

// ---------------------------------------------------------------------------
// B6 / DB-001..DB-009 — indexes for the collection scans on hot read paths.
//
// Five collections carried NO index at all beyond `_id`, and each is read on a
// path a user waits for. At seed-data scale a COLLSCAN is invisible; at ten
// thousand orders it is the outage.
//
// Every index here was chosen from the query shape that actually runs, not
// from the field that sounds right. Three deliberate NON-additions are
// recorded at the bottom, because "why is there no index on X" is the question
// this file will be asked later.
//
// Idempotency: the run inspects listIndexes() first and creates only what is
// missing. A second run reports every index as `skipped`. An index that exists
// under the same NAME but a different KEY is reported as `conflict` and left
// untouched — createIndex would throw IndexKeySpecsConflict, and silently
// dropping someone else's index is not a migration's decision to make.
// ---------------------------------------------------------------------------

export interface PlannedIndex {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  /** Why this exact key order — read this before changing one. */
  reason: string;
}

export const HOT_PATH_INDEXES: PlannedIndex[] = [
  // DB-002 — every PosTransaction read selects on orderId and sorts by
  // createdAt: the order-detail list (`sort({ createdAt: 1 })`), the
  // TransactionsLoader batch (`{ orderId: { $in } }`), and transaction history
  // (`{ orderId: { $in } }, sort({ createdAt: -1 })`). One compound key serves
  // all three; direction on the trailing field does not matter because Mongo
  // walks a compound index either way.
  {
    collection: 'pos_transactions',
    name: 'orderId_createdAt',
    key: { orderId: 1, createdAt: 1 },
    reason: 'order detail, TransactionsLoader batch, transaction history',
  },

  // DB-003 — InventoryService.findAll builds `{ uid, branchId?, ... }` with
  // uid ALWAYS present and branchId usually present (it is how branch scoping
  // is applied). isArchived is the third key because the inventory list is
  // filtered by it on essentially every screen. The remaining optional filters
  // (inventoryCategory, isActive, productName regex) are left out on purpose:
  // they are low-selectivity next to a tenant+branch prefix, and one index per
  // filter combination is how a write path dies.
  {
    collection: 'inventory',
    name: 'uid_branchId_isArchived',
    key: { uid: 1, branchId: 1, isArchived: 1 },
    reason:
      'inventory list, and the inventory lookup ProductsService fans out from',
  },

  // DB-003 (same module) — `find({ inventoryId }).sort({ createdAt: -1 })`.
  {
    collection: 'inventory_transactions',
    name: 'inventoryId_createdAt',
    key: { inventoryId: 1, createdAt: -1 },
    reason: 'per-item stock movement history',
  },

  // DB-004 — the selector is `{ inventoryId: { $in: [...] } }`, NOT `{ uid }`.
  // Products are reached by first resolving the caller's inventory ids and
  // fanning out. isArchived is in every one of those three queries (list,
  // findByInventory, duplicate-name check).
  {
    collection: 'products',
    name: 'inventoryId_isArchived',
    key: { inventoryId: 1, isArchived: 1 },
    reason: 'POS product list, findByInventory, duplicate-name check',
  },

  // DB-005 — `shopRatings` runs `{ branchId, isRemoved: false }` sorted by
  // createdAt desc, and `ratingHistogram` aggregates `$match: { branchId,
  // isRemoved: { $ne: true } }`. Both sit on the provider detail page, so they
  // run together on one request.
  {
    collection: 'ratings',
    name: 'branchId_isRemoved_createdAt',
    key: { branchId: 1, isRemoved: 1, createdAt: -1 },
    reason: 'provider-page review list and star histogram',
  },
];

// ---------------------------------------------------------------------------
// Deliberately NOT indexed — each of these looked like a gap and is not.
//
//   wallets.branchId       Already unique-indexed via `@Prop({ unique: true })`
//                          on the schema, which Mongoose builds as a real
//                          unique index. Every read is `findOne({ branchId })`
//                          or `{ branchId: { $in } }`, both served by it.
//
//   washer_profiles        `uid` is already unique-indexed, and the only query
//                          in the codebase is findById — i.e. `_id`.
//
//   products.productName   Search is `{ $regex: escaped, $options: 'i' }` with
//                          NO anchor. A B-tree index cannot serve an unanchored
//                          case-insensitive regex, so adding one would cost
//                          write throughput and buy nothing. The regex instead
//                          filters within the candidate set the
//                          inventoryId_isArchived index already narrows to one
//                          merchant's items, which is why POS search stays
//                          fast without a text index and without changing its
//                          substring-match UX. Revisit only if that candidate
//                          set stops being small.
// ---------------------------------------------------------------------------

export type IndexOutcome = 'created' | 'skipped' | 'conflict';

export interface IndexResult {
  collection: string;
  name: string;
  outcome: IndexOutcome;
  /** Present when outcome is 'conflict'. */
  existingKey?: Record<string, unknown>;
}

export interface HotPathIndexResult {
  created: number;
  skipped: number;
  conflicts: number;
  rows: IndexResult[];
}

/** Same fields in the same order with the same directions. */
function sameKey(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => bk[i] === k && Number(a[k]) === Number(b[k]));
}

/**
 * Create the hot-path indexes that are missing.
 *
 * Safe to re-run. Never drops or rebuilds an existing index — this only ever
 * adds, so a run cannot take a query plan away from a live system.
 */
export async function createHotPathIndexes(
  connection: Connection,
  log: (message: string) => void = () => {},
): Promise<HotPathIndexResult> {
  const rows: IndexResult[] = [];

  for (const planned of HOT_PATH_INDEXES) {
    const collection = connection.collection(planned.collection);

    // listIndexes throws NamespaceNotFound (26) when the collection does not
    // exist yet — a fresh database, which is a normal state, not an error.
    let existing: { name?: string; key?: Record<string, unknown> }[] = [];
    try {
      existing = (await collection.listIndexes().toArray()) as typeof existing;
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 26) throw err;
    }

    const byName = existing.find((ix) => ix.name === planned.name);
    if (byName) {
      if (sameKey(byName.key ?? {}, planned.key)) {
        rows.push({
          collection: planned.collection,
          name: planned.name,
          outcome: 'skipped',
        });
        log(
          `  skip     ${planned.collection}.${planned.name} (already present)`,
        );
      } else {
        rows.push({
          collection: planned.collection,
          name: planned.name,
          outcome: 'conflict',
          existingKey: byName.key,
        });
        log(
          `  CONFLICT ${planned.collection}.${planned.name} exists with a different key: ` +
            `${JSON.stringify(byName.key)} != ${JSON.stringify(planned.key)} — left untouched`,
        );
      }
      continue;
    }

    // A different name carrying the same key is still coverage. Creating a
    // duplicate would double the write cost for no read benefit.
    const byKey = existing.find((ix) => sameKey(ix.key ?? {}, planned.key));
    if (byKey) {
      rows.push({
        collection: planned.collection,
        name: planned.name,
        outcome: 'skipped',
      });
      log(
        `  skip     ${planned.collection}.${planned.name} (equivalent index "${byKey.name}" already covers it)`,
      );
      continue;
    }

    await collection.createIndex(planned.key, {
      name: planned.name,
      // Never block writes while the index builds. Modern MongoDB builds are
      // effectively background anyway; this is explicit so a future downgrade
      // cannot silently take a lock on a live collection.
      background: true,
    });
    rows.push({
      collection: planned.collection,
      name: planned.name,
      outcome: 'created',
    });
    log(
      `  created  ${planned.collection}.${planned.name} ${JSON.stringify(planned.key)}`,
    );
  }

  const result: HotPathIndexResult = {
    created: rows.filter((r) => r.outcome === 'created').length,
    skipped: rows.filter((r) => r.outcome === 'skipped').length,
    conflicts: rows.filter((r) => r.outcome === 'conflict').length,
    rows,
  };
  log(
    `hot-path indexes: ${result.created} created, ${result.skipped} skipped, ${result.conflicts} conflicts`,
  );
  return result;
}
