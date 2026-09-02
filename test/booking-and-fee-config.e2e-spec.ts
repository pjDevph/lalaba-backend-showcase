/**
 * CONFIGURATION, END TO END — the two admin-configurable money/capacity rules.
 *
 * Both features are "an admin changes a setting and every provider is affected
 * without anyone writing to a provider record". That claim is only testable
 * through the real application: the unit suites verify the arithmetic, but not
 * that the mutation is reachable, that roles gate it, that the rule is picked
 * up by the pricing path, or that a provider's own write is refused against it.
 *
 * 1. PLATFORM FEE — a commission rule is saved per payer role, and an order
 *    placed afterwards is priced and SNAPSHOTTED under that exact rule version.
 *    Home washers and laundromats can sit on different commissions.
 *
 * 2. WASHER BOOKING CEILING — a washer's own capacity is bounded by her
 *    computed entitlement (policy default → milestone → campaign → safety cap).
 *    The campaign case is the load-bearing one: ONE record raises the ceiling
 *    for every provider, and this spec asserts the washer's own document is
 *    untouched by it.
 */
import { Types } from 'mongoose';
import { createE2EApp, E2EContext } from './utils/e2e-app';
import {
  gql,
  gqlOk,
  firstErrorMessage,
  seedUser,
  seedWasher,
  seedMerchantBranch,
  seedWallet,
  seedAddress,
} from './utils/seed';

const ACTIVATED_BALANCE = 100_000; // ₱1,000 — clears the booking-eligibility gate

// ─── Platform fee ────────────────────────────────────────────────────────────

const CREATE_RULE = /* GraphQL */ `
  mutation CreateRule($input: SavePlatformFeeRuleInput!) {
    createPlatformFeeRule(input: $input) {
      ruleKey
      version
      percent
      appliesTo
      isActive
    }
  }
`;

const UPDATE_RULE = /* GraphQL */ `
  mutation UpdateRule($ruleKey: String!, $input: SavePlatformFeeRuleInput!) {
    updatePlatformFeeRule(ruleKey: $ruleKey, input: $input) {
      ruleKey
      version
      percent
    }
  }
`;

const QUOTE = /* GraphQL */ `
  query Quote($input: QuoteOrderInput!) {
    quoteOnlineOrder(input: $input) {
      serviceSubtotalCentavos
      platformFeePercent
      platformFeeCentavos
    }
  }
`;

const CREATE_ORDER = /* GraphQL */ `
  mutation Create($input: CreateOnlineOrderInput!) {
    createOnlineOrder(input: $input) {
      _id
      pricing {
        platformFeePercent
        platformFeeCentavos
        feeRuleKey
        feeRuleVersion
      }
    }
  }
`;

// ─── Booking policy ──────────────────────────────────────────────────────────

const PUBLISH_POLICY = /* GraphQL */ `
  mutation Publish($input: PublishBookingPolicyInput!) {
    publishBookingPolicy(input: $input) {
      version
      defaults {
        dailyCapacity
        perSlotCapacity
      }
      safetyLimits {
        dailyCapacity
      }
    }
  }
`;

const UPSERT_MILESTONE = /* GraphQL */ `
  mutation UpsertMilestone($input: UpsertBookingMilestoneInput!) {
    upsertBookingMilestone(input: $input) {
      key
      name
      rank
    }
  }
`;

const UPSERT_CAMPAIGN = /* GraphQL */ `
  mutation UpsertCampaign($input: UpsertBookingCampaignInput!) {
    upsertBookingCampaign(input: $input) {
      _id
      name
    }
  }
`;

const MY_ENTITLEMENT = /* GraphQL */ `
  query MyEntitlement {
    myBookingEntitlement {
      dailyCapacity
      perSlotCapacity
      advanceBookingDays
      milestoneName
      appliedCampaignNames
      cappedBySafetyLimit
    }
  }
`;

const UPDATE_CAPACITY = /* GraphQL */ `
  mutation UpdateCapacity($input: UpdateMyBookingCapacityInput!) {
    updateMyBookingCapacity(input: $input) {
      dailyBookingLimit
      maxBookingsPerSlot
    }
  }
`;

const ruleInput = (over: Record<string, unknown>) => ({
  name: 'Commission',
  appliesTo: 'HOME_WASHER',
  category: 'COMMISSION',
  calculationType: 'PERCENTAGE',
  percent: 10,
  basis: 'SERVICE_SUBTOTAL',
  chargedTo: 'CUSTOMER',
  deductFrom: 'NOT_DEDUCTED',
  taxTreatment: 'TAX_INCLUSIVE',
  applyVat: false,
  stackable: false,
  isActive: true,
  // Yesterday, so the rule is already in force the moment it is written.
  effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
  ...over,
});

const milestoneInput = (over: Record<string, unknown>) => ({
  key: 'growth',
  name: 'Growth',
  rank: 10,
  isDefault: false,
  isActive: true,
  eligibility: {
    minCompletedOrders: 0,
    requireVerified: false,
    requireGoodStanding: false,
  },
  entitlements: {
    dailyCapacity: 20,
    perSlotCapacity: 4,
    advanceBookingDays: 21,
    priorityBooking: false,
  },
  ...over,
});

const phToday = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const phPlusDays = (n: number) =>
  new Date(Date.now() + 8 * 3600 * 1000 + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

// scheduledPickup became REQUIRED on CreateOrderInput with booking
// availability; this suite predates that. Only `date` is non-null.
const SCHEDULED_PICKUP = {
  date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
};

describe('Admin configuration (e2e)', () => {
  let ctx: E2EContext;
  let server: any;
  let adminUid: string;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer();
    adminUid = await seedUser(ctx.connection, 'admin');
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Only the collections these tests own. Wiping everything would also delete
   * the `roles` documents RolesService seeds at bootstrap, which is what the
   * RolesGuard resolves an admin against — every admin mutation would then fail
   * with a permission error that had nothing to do with the feature.
   *
   * Providers/users are left to accumulate: each test seeds its own with unique
   * ids, so they cannot interfere.
   */
  beforeEach(async () => {
    const owned = [
      'booking_policies',
      'booking_milestones',
      'booking_campaigns',
      'booking_availability_configs',
      'booking_date_overrides',
      'booking_blackouts',
      'booking_slot_counters',
      'platform_fee_rules',
      'platform_fee_configs',
      'online_orders',
    ];
    await Promise.all(
      owned.map((name) => ctx.connection.collection(name).deleteMany({})),
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('platform fee configuration', () => {
    it('refuses a non-admin writing a fee rule', async () => {
      const washerUid = await seedUser(ctx.connection, 'washer');
      const res = await gql(
        server,
        CREATE_RULE,
        { input: ruleInput({}) },
        washerUid,
      );
      expect(firstErrorMessage(res)).toBeTruthy();
    });

    it('prices an order under the commission an admin just configured', async () => {
      await gqlOk(
        server,
        CREATE_RULE,
        { input: ruleInput({ percent: 15 }) },
        adminUid,
      );

      const templateId = await seedWasherTemplate(ctx, 20_000);
      const { branchId, ownerUid } = await seedWasher(ctx.connection, {
        verificationStatus: 'APPROVED',
        offeredServiceTemplateIds: [templateId],
      });
      await seedWallet(ctx.connection, branchId, ACTIVATED_BALANCE, true);

      const customerUid = await seedUser(ctx.connection, 'customer');
      const quote = await gqlOk<{ quoteOnlineOrder: Record<string, number> }>(
        server,
        QUOTE,
        {
          input: {
            branchId,
            providerType: 'WASHER',
            serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
            pickupMode: 'CUSTOMER_DROPOFF',
            returnMode: 'CUSTOMER_SELF_PICKUP',
          },
        },
        customerUid,
      );

      // 15% of the service subtotal, not the 10% default.
      const q = quote.quoteOnlineOrder;
      expect(q.platformFeePercent).toBe(15);
      expect(q.platformFeeCentavos).toBe(
        Math.round(q.serviceSubtotalCentavos * 0.15),
      );
      expect(ownerUid).toBeTruthy();
    });

    it('snapshots the exact rule version onto the order', async () => {
      const created = await gqlOk<{
        createPlatformFeeRule: { ruleKey: string; version: number };
      }>(server, CREATE_RULE, { input: ruleInput({ percent: 12 }) }, adminUid);
      const { ruleKey } = created.createPlatformFeeRule;

      const templateId = await seedWasherTemplate(ctx, 20_000);
      const { branchId } = await seedWasher(ctx.connection, {
        verificationStatus: 'APPROVED',
        offeredServiceTemplateIds: [templateId],
      });
      await seedWallet(ctx.connection, branchId, ACTIVATED_BALANCE, true);
      const customerUid = await seedUser(ctx.connection, 'customer');
      const addressId = await seedAddress(ctx.connection, customerUid);

      const order = await gqlOk<{
        createOnlineOrder: { pricing: Record<string, unknown> };
      }>(
        server,
        CREATE_ORDER,
        {
          input: {
            branchId,
            providerType: 'WASHER',
            addressId,
            serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
            pickupMode: 'CUSTOMER_DROPOFF',
            returnMode: 'CUSTOMER_SELF_PICKUP',
            scheduledPickup: SCHEDULED_PICKUP,
          },
        },
        customerUid,
      );

      const pricing = order.createOnlineOrder.pricing;
      expect(pricing.platformFeePercent).toBe(12);
      expect(pricing.feeRuleKey).toBe(ruleKey);
      expect(pricing.feeRuleVersion).toBe(1);

      // A later rate change must NOT rewrite the placed order's terms — that is
      // the whole reason the version is snapshotted.
      await gqlOk(
        server,
        UPDATE_RULE,
        { ruleKey, input: ruleInput({ percent: 25 }) },
        adminUid,
      );
      const stored = await ctx.connection
        .collection('online_orders')
        .findOne({});
      expect(stored?.pricing.platformFeePercent).toBe(12);
      expect(stored?.pricing.feeRuleVersion).toBe(1);
    });

    it('lets washers and laundromats sit on different commissions', async () => {
      await gqlOk(
        server,
        CREATE_RULE,
        { input: ruleInput({ percent: 15, appliesTo: 'HOME_WASHER' }) },
        adminUid,
      );
      await gqlOk(
        server,
        CREATE_RULE,
        {
          input: ruleInput({
            percent: 8,
            appliesTo: 'LAUNDROMAT',
            name: 'Laundromat commission',
          }),
        },
        adminUid,
      );

      const templateId = await seedWasherTemplate(ctx, 20_000);
      const washer = await seedWasher(ctx.connection, {
        verificationStatus: 'APPROVED',
        offeredServiceTemplateIds: [templateId],
      });
      await seedWallet(
        ctx.connection,
        washer.branchId,
        ACTIVATED_BALANCE,
        true,
      );

      const customerUid = await seedUser(ctx.connection, 'customer');
      const washerQuote = await gqlOk<{
        quoteOnlineOrder: { platformFeePercent: number };
      }>(
        server,
        QUOTE,
        {
          input: {
            branchId: washer.branchId,
            providerType: 'WASHER',
            serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
            pickupMode: 'CUSTOMER_DROPOFF',
            returnMode: 'CUSTOMER_SELF_PICKUP',
          },
        },
        customerUid,
      );

      expect(washerQuote.quoteOnlineOrder.platformFeePercent).toBe(15);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('washer booking ceiling', () => {
    async function seedWasherOwner() {
      const { branchId, ownerUid } = await seedWasher(ctx.connection, {
        verificationStatus: 'APPROVED',
      });
      await seedWallet(ctx.connection, branchId, ACTIVATED_BALANCE, true);
      return { branchId, ownerUid };
    }

    it('gives an unconfigured washer the platform default', async () => {
      const { ownerUid } = await seedWasherOwner();
      await gqlOk(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 10, perSlotCapacity: 2 } } },
        adminUid,
      );

      const res = await gqlOk<{
        myBookingEntitlement: Record<string, unknown>;
      }>(server, MY_ENTITLEMENT, {}, ownerUid);
      expect(res.myBookingEntitlement.dailyCapacity).toBe(10);
      expect(res.myBookingEntitlement.perSlotCapacity).toBe(2);
    });

    it('refuses a washer raising her own limit above the ceiling', async () => {
      const { ownerUid } = await seedWasherOwner();
      await gqlOk(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 10 } } },
        adminUid,
      );

      const res = await gql(
        server,
        UPDATE_CAPACITY,
        { input: { dailyBookingLimit: 30 } },
        ownerUid,
      );
      expect(firstErrorMessage(res)).toMatch(/up to 10/);
    });

    it('lets her throttle herself below it', async () => {
      const { ownerUid } = await seedWasherOwner();
      await gqlOk(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 10 } } },
        adminUid,
      );

      const res = await gqlOk<{
        updateMyBookingCapacity: { dailyBookingLimit: number };
      }>(
        server,
        UPDATE_CAPACITY,
        { input: { dailyBookingLimit: 4 } },
        ownerUid,
      );
      expect(res.updateMyBookingCapacity.dailyBookingLimit).toBe(4);
    });

    it('raises the ceiling when a milestone is unlocked', async () => {
      const { ownerUid } = await seedWasherOwner();
      await gqlOk(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 10 } } },
        adminUid,
      );
      await gqlOk(
        server,
        UPSERT_MILESTONE,
        { input: milestoneInput({}) },
        adminUid,
      );

      const ent = await gqlOk<{
        myBookingEntitlement: { dailyCapacity: number; milestoneName: string };
      }>(server, MY_ENTITLEMENT, {}, ownerUid);
      expect(ent.myBookingEntitlement.dailyCapacity).toBe(20);
      expect(ent.myBookingEntitlement.milestoneName).toBe('Growth');

      // 30 is still refused; 20 is now allowed.
      const refused = await gql(
        server,
        UPDATE_CAPACITY,
        { input: { dailyBookingLimit: 30 } },
        ownerUid,
      );
      expect(firstErrorMessage(refused)).toMatch(/up to 20/);

      const allowed = await gqlOk<{
        updateMyBookingCapacity: { dailyBookingLimit: number };
      }>(
        server,
        UPDATE_CAPACITY,
        { input: { dailyBookingLimit: 20 } },
        ownerUid,
      );
      expect(allowed.updateMyBookingCapacity.dailyBookingLimit).toBe(20);
    });

    /**
     * THE PROMO CASE. One campaign record doubles every washer's ceiling, and
     * the washer's own document is never written to — which is what makes this
     * safe at a million providers.
     */
    it('doubles the ceiling from one campaign, writing nothing to the washer', async () => {
      const { branchId, ownerUid } = await seedWasherOwner();
      await gqlOk(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 10 } } },
        adminUid,
      );

      const before = await ctx.connection
        .collection('booking_availability_configs')
        .findOne({ branchId });

      await gqlOk(
        server,
        UPSERT_CAMPAIGN,
        {
          input: {
            name: 'Laundry Week',
            startDate: phToday(),
            endDate: phPlusDays(7),
            isEnabled: true,
            targeting: { scope: 'EVERYONE', milestoneKeys: [] },
            dailyCapacity: { mode: 'MULTIPLY', value: 2 },
          },
        },
        adminUid,
      );

      const ent = await gqlOk<{
        myBookingEntitlement: {
          dailyCapacity: number;
          appliedCampaignNames: string[];
        };
      }>(server, MY_ENTITLEMENT, {}, ownerUid);
      expect(ent.myBookingEntitlement.dailyCapacity).toBe(20);
      expect(ent.myBookingEntitlement.appliedCampaignNames).toEqual([
        'Laundry Week',
      ]);

      // She can now ask for 20, which the ceiling of 10 would have refused.
      const allowed = await gqlOk<{
        updateMyBookingCapacity: { dailyBookingLimit: number };
      }>(
        server,
        UPDATE_CAPACITY,
        { input: { dailyBookingLimit: 20 } },
        ownerUid,
      );
      expect(allowed.updateMyBookingCapacity.dailyBookingLimit).toBe(20);

      // The campaign itself wrote nothing to her record: the only change is the
      // limit SHE just asked for.
      const after = await ctx.connection
        .collection('booking_availability_configs')
        .findOne({ branchId });
      expect(before?.dailyBookingLimit ?? null).toBeNull();
      expect(after?.dailyBookingLimit).toBe(20);

      const campaigns = await ctx.connection
        .collection('booking_campaigns')
        .countDocuments({});
      expect(campaigns).toBe(1);
    });

    it('never lets a campaign exceed the platform safety limit', async () => {
      const { ownerUid } = await seedWasherOwner();
      await gqlOk(
        server,
        PUBLISH_POLICY,
        {
          input: {
            defaults: { dailyCapacity: 10 },
            safetyLimits: { dailyCapacity: 15 },
          },
        },
        adminUid,
      );
      await gqlOk(
        server,
        UPSERT_CAMPAIGN,
        {
          input: {
            name: 'Runaway',
            startDate: phToday(),
            endDate: phPlusDays(1),
            isEnabled: true,
            targeting: { scope: 'EVERYONE', milestoneKeys: [] },
            dailyCapacity: { mode: 'MULTIPLY', value: 10 },
          },
        },
        adminUid,
      );

      const ent = await gqlOk<{
        myBookingEntitlement: {
          dailyCapacity: number;
          cappedBySafetyLimit: boolean;
        };
      }>(server, MY_ENTITLEMENT, {}, ownerUid);
      // 10 × 10 = 100, clamped to the 15 the admin set.
      expect(ent.myBookingEntitlement.dailyCapacity).toBe(15);
      expect(ent.myBookingEntitlement.cappedBySafetyLimit).toBe(true);
    });

    it('refuses a base capacity above the safety ceiling', async () => {
      const res = await gql(
        server,
        PUBLISH_POLICY,
        {
          input: {
            defaults: { dailyCapacity: 500 },
            safetyLimits: { dailyCapacity: 100 },
          },
        },
        adminUid,
      );
      expect(firstErrorMessage(res)).toMatch(
        /cannot exceed the platform maximum/,
      );
    });

    it('leaves a laundromat uncapped', async () => {
      const { branchId, ownerUid } = await seedMerchantBranch(ctx.connection, {
        verificationStatus: 'APPROVED',
      });
      await seedWallet(ctx.connection, branchId, ACTIVATED_BALANCE, true);
      await gqlOk(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 10 } } },
        adminUid,
      );

      const ent = await gqlOk<{
        myBookingEntitlement: {
          dailyCapacity: number | null;
          advanceBookingDays: number;
        };
      }>(server, MY_ENTITLEMENT, {}, ownerUid);
      expect(ent.myBookingEntitlement.dailyCapacity).toBeNull();
      // …but the timing rules still govern it.
      expect(ent.myBookingEntitlement.advanceBookingDays).toBeGreaterThan(0);
    });

    it('publishes a new policy version rather than mutating the old one', async () => {
      const first = await gqlOk<{ publishBookingPolicy: { version: number } }>(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 10 }, changeNote: 'first' } },
        adminUid,
      );
      const second = await gqlOk<{ publishBookingPolicy: { version: number } }>(
        server,
        PUBLISH_POLICY,
        { input: { defaults: { dailyCapacity: 12 }, changeNote: 'second' } },
        adminUid,
      );
      expect(second.publishBookingPolicy.version).toBe(
        first.publishBookingPolicy.version + 1,
      );

      const live = await ctx.connection
        .collection('booking_policies')
        .countDocuments({ status: 'live' });
      const all = await ctx.connection
        .collection('booking_policies')
        .countDocuments({});
      // Exactly one live version, and the previous one is still readable.
      expect(live).toBe(1);
      expect(all).toBeGreaterThanOrEqual(2);
    });
  });
});

/** A washer service template priced in centavos per kg. */
async function seedWasherTemplate(
  ctx: E2EContext,
  basePriceCentavos: number,
): Promise<string> {
  const _id = new Types.ObjectId();
  await ctx.connection.collection('washer_service_templates').insertOne({
    _id,
    name: `E2E Wash ${Date.now()}${Math.floor(Math.random() * 1000)}`,
    description: null,
    pricingControl: 'washer_set',
    allowedPricingModels: ['per_kg', 'per_load', 'base_excess'],
    minPriceCentavos: null,
    maxPriceCentavos: null,
    basePriceCentavos,
    baseWeightKg: 5,
    excessRatePerKgCentavos: 2_000,
    turnaroundHours: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return String(_id);
}
