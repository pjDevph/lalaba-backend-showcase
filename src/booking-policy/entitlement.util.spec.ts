import {
  campaignApplies,
  isCampaignLive,
  nextMilestone,
  resolveEntitlement,
  resolveMilestone,
  satisfies,
  ProviderStats,
} from './entitlement.util';
import { BookingPolicy, POLICY_SEED } from './schemas/booking-policy.schema';
import { BookingMilestone } from './schemas/booking-milestone.schema';
import {
  BookingCampaign,
  CampaignModifierMode,
  CampaignScope,
} from './schemas/booking-campaign.schema';
import { ProviderType } from '../online-orders/schemas/order-status.enum';

const DATE = '2026-08-23';

const policy = (over: Record<string, unknown> = {}): BookingPolicy =>
  ({
    enabled: true,
    defaults: {
      dailyCapacity: 10,
      advanceBookingDays: 14,
      leadTimeMinutes: 120,
      sameDayBookingEnabled: true,
      sameDayCutoffTime: '17:00',
    },
    safetyLimits: {
      dailyCapacity: 100,
      advanceBookingDays: 60,
    },
    ...over,
  }) as unknown as BookingPolicy;

const milestone = (
  key: string,
  rank: number,
  entitlements: Record<string, unknown>,
  eligibility: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
): BookingMilestone =>
  ({
    key,
    name: key[0].toUpperCase() + key.slice(1),
    rank,
    isDefault: false,
    isActive: true,
    eligibility: {
      minCompletedOrders: null,
      minRating: null,
      maxCancellationRatePercent: null,
      requireVerified: false,
      requireGoodStanding: false,
      ...eligibility,
    },
    entitlements: { priorityBooking: false, ...entitlements },
    ...over,
  }) as unknown as BookingMilestone;

const LADDER: BookingMilestone[] = [
  milestone(
    'starter',
    0,
    { dailyCapacity: 10, perSlotCapacity: 2, advanceBookingDays: 14 },
    {},
    { isDefault: true },
  ),
  milestone(
    'growth',
    10,
    { dailyCapacity: 20, perSlotCapacity: 4, advanceBookingDays: 21 },
    { minCompletedOrders: 50, minRating: 4.5 },
  ),
  milestone(
    'pro',
    20,
    { dailyCapacity: 40, perSlotCapacity: 6, advanceBookingDays: 30 },
    { minCompletedOrders: 200, minRating: 4.7, maxCancellationRatePercent: 5 },
  ),
];

const stats = (over: Partial<ProviderStats> = {}): ProviderStats => ({
  completedOrders: 0,
  rating: null,
  cancellationRatePercent: null,
  isVerified: false,
  inGoodStanding: true,
  ...over,
});

const campaign = (over: Record<string, unknown> = {}): BookingCampaign => ({
  _id: 'camp1',
  name: 'Laundry Week',
  startDate: '2026-08-20',
  endDate: '2026-08-27',
  isEnabled: true,
  targeting: { scope: CampaignScope.EVERYONE, milestoneKeys: [] },
  dailyCapacity: null,
  advanceBookingDays: null,
  ...over,
});

const resolve = (over: {
  policy?: BookingPolicy | null;
  milestones?: BookingMilestone[];
  campaigns?: BookingCampaign[];
  stats?: ProviderStats;
  providerType?: ProviderType;
  date?: string;
}) =>
  resolveEntitlement({
    policy: over.policy === undefined ? policy() : over.policy,
    milestones: over.milestones ?? LADDER,
    campaigns: over.campaigns ?? [],
    stats: over.stats ?? stats(),
    providerType: over.providerType ?? ProviderType.WASHER,
    date: over.date ?? DATE,
  });

describe('satisfies', () => {
  it('accepts a provider who clears every threshold', () => {
    expect(
      satisfies(LADDER[1], stats({ completedOrders: 60, rating: 4.6 })),
    ).toBe(true);
  });

  it('rejects one short on orders', () => {
    expect(
      satisfies(LADDER[1], stats({ completedOrders: 49, rating: 5 })),
    ).toBe(false);
  });

  // An unrated provider has not earned a 4.5-rating tier by having no rating.
  it('rejects an unrated provider against a rating threshold', () => {
    expect(satisfies(LADDER[1], stats({ completedOrders: 100 }))).toBe(false);
  });

  // But a provider who has simply never cancelled must not be locked out of a
  // tier that caps cancellations.
  it('accepts an immeasurable cancellation rate', () => {
    expect(
      satisfies(
        LADDER[2],
        stats({
          completedOrders: 300,
          rating: 4.9,
          cancellationRatePercent: null,
        }),
      ),
    ).toBe(true);
  });

  it('rejects a cancellation rate over the cap', () => {
    expect(
      satisfies(
        LADDER[2],
        stats({
          completedOrders: 300,
          rating: 4.9,
          cancellationRatePercent: 9,
        }),
      ),
    ).toBe(false);
  });

  it('enforces the verified requirement', () => {
    const m = milestone(
      'verified-only',
      5,
      { dailyCapacity: 15, perSlotCapacity: 3, advanceBookingDays: 14 },
      { requireVerified: true },
    );
    expect(satisfies(m, stats({ isVerified: false }))).toBe(false);
    expect(satisfies(m, stats({ isVerified: true }))).toBe(true);
  });
});

describe('resolveMilestone', () => {
  it('gives a brand-new provider the default tier', () => {
    expect(resolveMilestone(LADDER, stats())?.key).toBe('starter');
  });

  it('picks the highest tier a provider satisfies', () => {
    expect(
      resolveMilestone(
        LADDER,
        stats({
          completedOrders: 250,
          rating: 4.8,
          cancellationRatePercent: 2,
        }),
      )?.key,
    ).toBe('pro');
  });

  it('falls back to the tier below when the top one is missed', () => {
    expect(
      resolveMilestone(
        LADDER,
        stats({
          completedOrders: 250,
          rating: 4.6,
          cancellationRatePercent: 2,
        }),
      )?.key,
    ).toBe('growth');
  });

  it('ignores a deactivated tier', () => {
    const ladder = [
      LADDER[0],
      { ...LADDER[1], isActive: false } as BookingMilestone,
      LADDER[2],
    ];
    expect(
      resolveMilestone(ladder, stats({ completedOrders: 60, rating: 4.6 }))
        ?.key,
    ).toBe('starter');
  });
});

describe('resolveEntitlement', () => {
  it('uses the platform defaults for a provider on the default tier', () => {
    const e = resolve({});
    expect(e.dailyCapacity).toBe(10);
    expect(e.advanceBookingDays).toBe(14);
    expect(e.milestoneKey).toBe('starter');
  });

  it('applies the unlocked milestone', () => {
    const e = resolve({
      stats: stats({ completedOrders: 60, rating: 4.6 }),
    });
    expect(e.dailyCapacity).toBe(20);
    expect(e.milestoneName).toBe('Growth');
  });

  // The promo that motivated the design: ONE record, every tier scales.
  it('scales the whole ladder from a single multiply campaign', () => {
    const promo = campaign({
      dailyCapacity: { mode: CampaignModifierMode.MULTIPLY, value: 2 },
    });

    const starter = resolve({ campaigns: [promo] });
    const growth = resolve({
      campaigns: [promo],
      stats: stats({ completedOrders: 60, rating: 4.6 }),
    });
    const pro = resolve({
      campaigns: [promo],
      stats: stats({
        completedOrders: 300,
        rating: 4.9,
        cancellationRatePercent: 1,
      }),
    });

    expect(starter.dailyCapacity).toBe(20);
    expect(growth.dailyCapacity).toBe(40);
    expect(pro.dailyCapacity).toBe(80);
  });

  it('ignores a campaign outside its date window', () => {
    const e = resolve({
      campaigns: [
        campaign({
          startDate: '2026-09-01',
          endDate: '2026-09-07',
          dailyCapacity: { mode: CampaignModifierMode.MULTIPLY, value: 2 },
        }),
      ],
    });
    expect(e.dailyCapacity).toBe(10);
    expect(e.appliedCampaignNames).toEqual([]);
  });

  it('ignores a disabled campaign inside its window', () => {
    const e = resolve({
      campaigns: [
        campaign({
          isEnabled: false,
          dailyCapacity: { mode: CampaignModifierMode.MULTIPLY, value: 2 },
        }),
      ],
    });
    expect(e.dailyCapacity).toBe(10);
  });

  it('adds a flat increase', () => {
    const e = resolve({
      campaigns: [
        campaign({
          advanceBookingDays: {
            mode: CampaignModifierMode.INCREASE_BY,
            value: 7,
          },
        }),
      ],
    });
    expect(e.advanceBookingDays).toBe(21);
  });

  it('replaces outright', () => {
    const e = resolve({
      campaigns: [
        campaign({
          dailyCapacity: { mode: CampaignModifierMode.REPLACE, value: 33 },
        }),
      ],
    });
    expect(e.dailyCapacity).toBe(33);
  });

  it('leaves untouched entitlements alone', () => {
    const e = resolve({
      campaigns: [
        campaign({
          advanceBookingDays: {
            mode: CampaignModifierMode.INCREASE_BY,
            value: 7,
          },
        }),
      ],
    });
    expect(e.dailyCapacity).toBe(10);
  });

  // The backstop against an accidental multiplier reaching real queues.
  it('clamps a runaway multiplier to the safety limit', () => {
    const e = resolve({
      stats: stats({
        completedOrders: 300,
        rating: 4.9,
        cancellationRatePercent: 1,
      }),
      campaigns: [
        campaign({
          dailyCapacity: { mode: CampaignModifierMode.MULTIPLY, value: 10 },
        }),
      ],
    });
    // Pro 40 × 10 = 400, capped at 100.
    expect(e.dailyCapacity).toBe(100);
    expect(e.cappedBySafetyLimit).toBe(true);
  });

  it('does not claim a safety cap when none bit', () => {
    expect(resolve({}).cappedBySafetyLimit).toBe(false);
  });

  it('rounds a fractional multiplier down', () => {
    const e = resolve({
      campaigns: [
        campaign({
          dailyCapacity: { mode: CampaignModifierMode.MULTIPLY, value: 1.5 },
        }),
      ],
    });
    // 10 × 1.5 = 15 exactly; the floor matters on odd bases.
    expect(e.dailyCapacity).toBe(15);
    const odd = resolve({
      policy: policy({
        defaults: { ...policy().defaults, dailyCapacity: 5 },
      }),
      campaigns: [
        campaign({
          dailyCapacity: { mode: CampaignModifierMode.MULTIPLY, value: 1.5 },
        }),
      ],
      milestones: [],
    });
    expect(odd.dailyCapacity).toBe(7);
  });

  it('leaves a laundromat uncapped but still governed on timing', () => {
    const e = resolve({ providerType: ProviderType.MERCHANT });
    expect(e.dailyCapacity).toBeNull();
    expect(e.milestoneKey).toBeNull();
    // Timing is still the platform's.
    expect(e.advanceBookingDays).toBe(14);
    expect(e.leadTimeMinutes).toBe(120);
  });

  it('falls back to seed values when no policy exists yet', () => {
    const e = resolve({ policy: null, milestones: [] });
    // The launch number for home washers — see POLICY_SEED.
    expect(e.dailyCapacity).toBe(POLICY_SEED.dailyCapacity);
    expect(e.advanceBookingDays).toBe(POLICY_SEED.advanceBookingDays);
  });

  it('records the calculation for the simulator', () => {
    const e = resolve({
      stats: stats({ completedOrders: 60, rating: 4.6 }),
      campaigns: [
        campaign({
          dailyCapacity: { mode: CampaignModifierMode.MULTIPLY, value: 2 },
        }),
      ],
    });
    expect(e.steps.map((s) => s.label)).toEqual([
      'Platform default',
      'Milestone: Growth',
      'Campaign: Laundry Week',
    ]);
    expect(e.steps[2].dailyCapacity).toBe(40);
  });

  it('carries the platform master switch through', () => {
    expect(
      resolve({ policy: policy({ enabled: false }) }).bookingsEnabled,
    ).toBe(false);
  });
});

describe('campaign targeting', () => {
  it('covers only its own dates', () => {
    const c = campaign();
    expect(isCampaignLive(c, '2026-08-19')).toBe(false);
    expect(isCampaignLive(c, '2026-08-20')).toBe(true);
    expect(isCampaignLive(c, '2026-08-27')).toBe(true);
    expect(isCampaignLive(c, '2026-08-28')).toBe(false);
  });

  it('targets everyone by default', () => {
    expect(campaignApplies(campaign(), ProviderType.WASHER, 'starter')).toBe(
      true,
    );
    expect(campaignApplies(campaign(), ProviderType.MERCHANT, null)).toBe(true);
  });

  it('targets one provider type', () => {
    const c = campaign({
      targeting: {
        scope: CampaignScope.PROVIDER_TYPE,
        providerType: ProviderType.WASHER,
        milestoneKeys: [],
      },
    });
    expect(campaignApplies(c, ProviderType.WASHER, 'starter')).toBe(true);
    expect(campaignApplies(c, ProviderType.MERCHANT, null)).toBe(false);
  });

  it('targets named milestones', () => {
    const c = campaign({
      targeting: {
        scope: CampaignScope.MILESTONE,
        providerType: null,
        milestoneKeys: ['growth', 'pro'],
      },
    });
    expect(campaignApplies(c, ProviderType.WASHER, 'growth')).toBe(true);
    expect(campaignApplies(c, ProviderType.WASHER, 'starter')).toBe(false);
    expect(campaignApplies(c, ProviderType.WASHER, null)).toBe(false);
  });
});

describe('nextMilestone', () => {
  it('points at the next rung up', () => {
    expect(nextMilestone(LADDER, LADDER[1])?.key).toBe('pro');
  });

  it('points at the first real tier from the default', () => {
    expect(nextMilestone(LADDER, LADDER[0])?.key).toBe('growth');
  });

  it('returns nothing at the top of the ladder', () => {
    expect(nextMilestone(LADDER, LADDER[2])).toBeNull();
  });
});
