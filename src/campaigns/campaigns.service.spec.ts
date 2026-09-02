import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { CampaignsService } from './campaigns.service';
import {
  Campaign,
  CampaignActionType,
  CampaignFrequency,
  CampaignSchema,
  CampaignStatus,
} from './schemas/campaign.schema';
import {
  CampaignImpression,
  CampaignImpressionSchema,
} from './schemas/campaign-impression.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { APP_OPEN_FLOOR_MINUTES } from './campaign-frequency.util';

describe('CampaignsService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: CampaignsService;

  const NOW = new Date('2026-08-24T04:00:00Z'); // midday Manila, a Monday

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: Campaign.name, schema: CampaignSchema },
          { name: CampaignImpression.name, schema: CampaignImpressionSchema },
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
        ]),
      ],
      providers: [CampaignsService],
    }).compile();

    service = module.get(CampaignsService);
    connection = module.get<Connection>(getConnectionToken());
    // The frequency rule is a unique index. Without this the collection has no
    // indexes yet and every test would pass for the wrong reason.
    await connection.models[CampaignImpression.name].syncIndexes();
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [Campaign.name, CampaignImpression.name]) {
      await connection.models[name].deleteMany({});
    }
  });

  /** A User-shaped object with a populated role, as the guard supplies it. */
  const actor = (roleId: string, uid = new Types.ObjectId().toString()) =>
    ({ _id: uid, role: { roleId } }) as unknown as User;

  const makeCampaign = async (over: Record<string, unknown> = {}) =>
    connection.models[Campaign.name].create({
      name: 'Test campaign',
      targetRoleIds: ['customer'],
      imageUrl: 'https://example.test/a.jpg',
      frequency: CampaignFrequency.ONCE_EVER,
      actionType: CampaignActionType.NONE,
      startsAt: new Date(NOW.getTime() - 86_400_000),
      status: CampaignStatus.ACTIVE,
      priority: 0,
      createdByUid: 'admin-1',
      createdByName: 'Admin',
      ...over,
    });

  describe('targeting', () => {
    it('shows a campaign to the role it targets', async () => {
      await makeCampaign({ targetRoleIds: ['customer'] });
      const shown = await service.nextFor(actor('customer'), null, NOW);
      expect(shown?.name).toBe('Test campaign');
    });

    it('hides a merchant campaign from washers and customers', async () => {
      // Merchant and washer are distinct roles even though they share an app.
      await makeCampaign({
        targetRoleIds: ['merchant'],
        name: 'Merchant only',
      });
      expect(await service.nextFor(actor('washer'), null, NOW)).toBeNull();
      expect(await service.nextFor(actor('customer'), null, NOW)).toBeNull();
      expect((await service.nextFor(actor('merchant'), null, NOW))?.name).toBe(
        'Merchant only',
      );
    });

    it('does not leak a partner campaign to staff or couriers', async () => {
      // Staff do not inherit their employer's incentives.
      await makeCampaign({ targetRoleIds: ['merchant', 'washer'] });
      expect(await service.nextFor(actor('staff'), null, NOW)).toBeNull();
      expect(await service.nextFor(actor('courier'), null, NOW)).toBeNull();
    });

    it('returns nothing for an account with no resolvable role', async () => {
      await makeCampaign();
      const roleless = { _id: 'u1' } as unknown as User;
      expect(await service.nextFor(roleless, null, NOW)).toBeNull();
    });
  });

  describe('scheduling', () => {
    it('ignores a campaign that has not started', async () => {
      await makeCampaign({ startsAt: new Date(NOW.getTime() + 86_400_000) });
      expect(await service.nextFor(actor('customer'), null, NOW)).toBeNull();
    });

    it('ignores a campaign that has ended', async () => {
      await makeCampaign({ endsAt: new Date(NOW.getTime() - 1) });
      expect(await service.nextFor(actor('customer'), null, NOW)).toBeNull();
    });

    it('keeps running a campaign with no end date', async () => {
      await makeCampaign({ endsAt: null });
      expect(
        await service.nextFor(actor('customer'), null, NOW),
      ).not.toBeNull();
    });

    it.each([
      CampaignStatus.DRAFT,
      CampaignStatus.PAUSED,
      CampaignStatus.ARCHIVED,
    ])('never shows a %s campaign', async (status) => {
      await makeCampaign({ status });
      expect(await service.nextFor(actor('customer'), null, NOW)).toBeNull();
    });
  });

  describe('one at a time', () => {
    it('returns only the highest-priority campaign, never a queue', async () => {
      await makeCampaign({ name: 'Low', priority: 1 });
      await makeCampaign({ name: 'High', priority: 100 });
      await makeCampaign({ name: 'Mid', priority: 50 });

      const first = await service.nextFor(actor('customer'), null, NOW);
      expect(first?.name).toBe('High');
    });

    it('offers the next one down on a later request', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ name: 'High', priority: 100 });
      await makeCampaign({ name: 'Low', priority: 1 });

      expect(
        (await service.nextFor(actor('customer', uid), null, NOW))?.name,
      ).toBe('High');
      // Same account, next day: High is spent (ONCE_EVER), Low is due.
      const tomorrow = new Date(NOW.getTime() + 86_400_000);
      expect(
        (await service.nextFor(actor('customer', uid), null, tomorrow))?.name,
      ).toBe('Low');
    });
  });

  describe('frequency', () => {
    it('ONCE_EVER shows exactly once, ever', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ frequency: CampaignFrequency.ONCE_EVER });

      expect(
        await service.nextFor(actor('customer', uid), null, NOW),
      ).not.toBeNull();
      expect(
        await service.nextFor(actor('customer', uid), null, NOW),
      ).toBeNull();
      const nextYear = new Date('2027-08-24T04:00:00Z');
      expect(
        await service.nextFor(actor('customer', uid), null, nextYear),
      ).toBeNull();
    });

    it('ONCE_EVER is per account, not global', async () => {
      await makeCampaign({ frequency: CampaignFrequency.ONCE_EVER });
      expect(
        await service.nextFor(actor('customer'), null, NOW),
      ).not.toBeNull();
      expect(
        await service.nextFor(actor('customer'), null, NOW),
      ).not.toBeNull();
    });

    it('DAILY resets on the Manila day boundary', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ frequency: CampaignFrequency.DAILY });

      // 15:59Z — still the 24th in Manila.
      const evening = new Date('2026-08-24T15:59:00Z');
      expect(
        await service.nextFor(actor('customer', uid), null, evening),
      ).not.toBeNull();
      expect(
        await service.nextFor(actor('customer', uid), null, evening),
      ).toBeNull();

      // 16:00Z — Manila midnight, a new day. UTC still says the 24th.
      const manilaMidnight = new Date('2026-08-24T16:00:00Z');
      expect(
        await service.nextFor(actor('customer', uid), null, manilaMidnight),
      ).not.toBeNull();
    });

    it('WEEKLY holds all week and resets on Manila Monday', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ frequency: CampaignFrequency.WEEKLY });

      expect(
        await service.nextFor(actor('customer', uid), null, NOW),
      ).not.toBeNull();
      const sunday = new Date('2026-08-30T04:00:00Z');
      expect(
        await service.nextFor(actor('customer', uid), null, sunday),
      ).toBeNull();
      const nextMonday = new Date('2026-08-31T04:00:00Z');
      expect(
        await service.nextFor(actor('customer', uid), null, nextMonday),
      ).not.toBeNull();
    });

    it('EVERY_LOGIN shows once per session', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ frequency: CampaignFrequency.EVERY_LOGIN });

      expect(
        await service.nextFor(actor('customer', uid), 'sess-1', NOW),
      ).not.toBeNull();
      expect(
        await service.nextFor(actor('customer', uid), 'sess-1', NOW),
      ).toBeNull();
      expect(
        await service.nextFor(actor('customer', uid), 'sess-2', NOW),
      ).not.toBeNull();
    });

    it('EVERY_LOGIN is skipped rather than fatal when no session is supplied', async () => {
      // The app still deserves an answer — and a lower-priority campaign that
      // IS showable should still get its turn.
      await makeCampaign({
        frequency: CampaignFrequency.EVERY_LOGIN,
        priority: 100,
        name: 'Login',
      });
      await makeCampaign({
        frequency: CampaignFrequency.DAILY,
        priority: 1,
        name: 'Daily',
      });

      const shown = await service.nextFor(actor('customer'), null, NOW);
      expect(shown?.name).toBe('Daily');
    });

    it('EVERY_APP_OPEN respects the server floor across bucket boundaries', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ frequency: CampaignFrequency.EVERY_APP_OPEN });

      expect(
        await service.nextFor(actor('customer', uid), null, NOW),
      ).not.toBeNull();

      // One minute later, and deliberately in the NEXT bucket — the key alone
      // would allow this, which is exactly why there is a floor check too.
      const justAfter = new Date(NOW.getTime() + 60_000);
      expect(
        await service.nextFor(actor('customer', uid), null, justAfter),
      ).toBeNull();

      const afterFloor = new Date(
        NOW.getTime() + (APP_OPEN_FLOOR_MINUTES + 1) * 60_000,
      );
      expect(
        await service.nextFor(actor('customer', uid), null, afterFloor),
      ).not.toBeNull();
    });
  });

  describe('impression records', () => {
    it('stamps a role and never expires a ONCE_EVER row', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ frequency: CampaignFrequency.ONCE_EVER });
      await service.nextFor(actor('customer', uid), null, NOW);

      const [row] = await connection.models[CampaignImpression.name]
        .find({ uid })
        .exec();
      expect(row.roleId).toBe('customer');
      expect(row.expiresAt).toBeNull();
    });

    it('gives a periodic row a sweep date', async () => {
      const uid = new Types.ObjectId().toString();
      await makeCampaign({ frequency: CampaignFrequency.DAILY });
      await service.nextFor(actor('customer', uid), null, NOW);

      const [row] = await connection.models[CampaignImpression.name]
        .find({ uid })
        .exec();
      expect(row.expiresAt).not.toBeNull();
    });

    it('records a click and a dismissal against the showing', async () => {
      const uid = new Types.ObjectId().toString();
      const campaign = await makeCampaign();
      await service.nextFor(actor('customer', uid), null, NOW);

      expect(
        await service.recordInteraction(String(campaign._id), uid, 'CLICKED'),
      ).toBe(true);
      expect(
        await service.recordInteraction(String(campaign._id), uid, 'DISMISSED'),
      ).toBe(true);
      // Already stamped — nothing left to record.
      expect(
        await service.recordInteraction(String(campaign._id), uid, 'CLICKED'),
      ).toBe(false);
    });

    it("cannot stamp another account's impression", async () => {
      const mine = new Types.ObjectId().toString();
      const theirs = new Types.ObjectId().toString();
      const campaign = await makeCampaign();
      await service.nextFor(actor('customer', mine), null, NOW);

      expect(
        await service.recordInteraction(
          String(campaign._id),
          theirs,
          'CLICKED',
        ),
      ).toBe(false);
    });
  });
});
