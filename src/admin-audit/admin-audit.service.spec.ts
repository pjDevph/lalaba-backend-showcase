import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';

import { AdminAuditService } from './admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditEvent,
  AdminAuditEventSchema,
  AdminAuditTargetType,
} from './schemas/admin-audit-event.schema';
import type { User } from '../users/schemas/user.schema';

describe('AdminAuditService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: AdminAuditService;

  const actor = {
    _id: 'admin-uid-1',
    firstName: 'Ada',
    lastName: 'Reyes',
    email: 'ada@lalaba.ph',
    role: { roleId: 'admin' },
  } as unknown as User;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
        ]),
      ],
      providers: [AdminAuditService],
    }).compile();

    service = module.get(AdminAuditService);
    connection = module.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await connection.models[AdminAuditEvent.name].deleteMany({});
  });

  it('records who did what, to whom, and why', async () => {
    await service.record({
      action: AdminAuditAction.PROVIDER_SUSPENDED,
      actor,
      targetType: AdminAuditTargetType.PROVIDER,
      targetId: 'branch-1',
      targetLabel: "Maria's Laundry",
      reasonCode: 'FRAUD_SUSPECTED',
      note: 'Three chargebacks this week.',
    });

    const [event] = (await service.find()).data;

    expect(event).toMatchObject({
      action: AdminAuditAction.PROVIDER_SUSPENDED,
      actorUid: 'admin-uid-1',
      actorName: 'Ada Reyes',
      actorEmail: 'ada@lalaba.ph',
      actorRole: 'admin',
      targetType: AdminAuditTargetType.PROVIDER,
      targetId: 'branch-1',
      targetLabel: "Maria's Laundry",
      reasonCode: 'FRAUD_SUSPECTED',
      note: 'Three chargebacks this week.',
    });
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  // The actor's details are denormalised so the trail still reads correctly
  // after the account is renamed or removed. Resolving them at read time
  // would silently rewrite history.
  it('keeps the actor name recorded at the time of the action', async () => {
    await service.record({
      action: AdminAuditAction.ACCOUNT_DEACTIVATED,
      actor,
      targetType: AdminAuditTargetType.USER,
      targetId: 'user-1',
      reasonCode: 'DUPLICATE_ACCOUNT',
    });

    // The actor is later renamed — the stored event must not follow.
    const renamed = { ...actor, firstName: 'Someone', lastName: 'Else' };
    await service.record({
      action: AdminAuditAction.ACCOUNT_REACTIVATED,
      actor: renamed,
      targetType: AdminAuditTargetType.USER,
      targetId: 'user-1',
    });

    const events = (await service.find()).data;
    const names = events.map((e) => e.actorName).sort();
    expect(names).toEqual(['Ada Reyes', 'Someone Else']);
  });

  it('reads a role supplied as a bare id rather than a populated document', async () => {
    await service.record({
      action: AdminAuditAction.ADMIN_INVITED,
      actor: { ...actor, role: 'support' },
      targetType: AdminAuditTargetType.USER,
      targetId: 'user-2',
    });

    expect((await service.find()).data[0].actorRole).toBe('support');
  });

  it('falls back to the uid when the actor has no name', async () => {
    await service.record({
      action: AdminAuditAction.ADMIN_INVITED,
      actor: {
        _id: 'nameless-uid',
        email: 'x@y.z',
        role: 'admin',
      } as unknown as User,
      targetType: AdminAuditTargetType.USER,
      targetId: 'user-3',
    });

    expect((await service.find()).data[0].actorName).toBe('nameless-uid');
  });

  // The contract the callers depend on: a logging failure must never roll back
  // the action it describes. A suspension that half-succeeded — provider
  // suspended, caller sees an error — is worse than a missing log line.
  it('never throws, even when the write fails', async () => {
    await expect(
      service.record({
        // Not a member of the enum, so mongoose validation rejects it.
        action: 'NOT_A_REAL_ACTION' as AdminAuditAction,
        actor,
        targetType: AdminAuditTargetType.USER,
        targetId: 'user-4',
      }),
    ).resolves.toBeUndefined();

    expect((await service.find()).total).toBe(0);
  });

  it('stores structured details and serialises them for the panel', async () => {
    await service.record({
      action: AdminAuditAction.PROVIDER_CAP_CHANGED,
      actor,
      targetType: AdminAuditTargetType.PROVIDER,
      targetId: 'branch-2',
      details: { from: 10, to: 3 },
    });

    const [event] = (await service.find()).data;
    expect(event.details).toEqual({ from: 10, to: 3 });
  });

  describe('find', () => {
    const seed = async (
      action: AdminAuditAction,
      targetId: string,
      actorUid = 'admin-uid-1',
    ) =>
      service.record({
        action,
        actor: { ...actor, _id: actorUid },
        targetType: AdminAuditTargetType.PROVIDER,
        targetId,
      });

    it('returns newest first', async () => {
      await seed(AdminAuditAction.PROVIDER_SUSPENDED, 'a');
      await seed(AdminAuditAction.PROVIDER_REACTIVATED, 'b');

      const { data } = await service.find();

      expect(data[0].targetId).toBe('b');
    });

    it('filters by action, actor and target', async () => {
      await seed(AdminAuditAction.PROVIDER_SUSPENDED, 'a', 'admin-1');
      await seed(AdminAuditAction.PROVIDER_REACTIVATED, 'a', 'admin-2');
      await seed(AdminAuditAction.PROVIDER_SUSPENDED, 'b', 'admin-2');

      expect(
        (
          await service.find({
            actions: [AdminAuditAction.PROVIDER_SUSPENDED],
          })
        ).total,
      ).toBe(2);
      expect((await service.find({ actorUid: 'admin-2' })).total).toBe(2);
      expect((await service.find({ targetId: 'a' })).total).toBe(2);
    });

    it('reports a total for the whole match, not the page', async () => {
      for (let i = 0; i < 5; i++) {
        await seed(AdminAuditAction.PROVIDER_SUSPENDED, `t-${i}`);
      }

      const page = await service.find({ limit: 2 });

      expect(page.data).toHaveLength(2);
      expect(page.total).toBe(5);
    });

    it('returns an empty page rather than everything for an unmatched filter', async () => {
      await seed(AdminAuditAction.PROVIDER_SUSPENDED, 'a');

      const page = await service.find({
        actorUid: new Types.ObjectId().toString(),
      });

      expect(page.total).toBe(0);
      expect(page.data).toEqual([]);
    });
  });
});
