import { BookingPolicy, POLICY_SEED } from './schemas/booking-policy.schema';
import { BookingMilestone } from './schemas/booking-milestone.schema';
import {
  BookingCampaign,
  CampaignModifier,
  CampaignModifierMode,
  CampaignScope,
} from './schemas/booking-campaign.schema';
import { ProviderType } from '../online-orders/schemas/order-status.enum';

/**
 * EFFECTIVE ENTITLEMENT — computed, never stored on a provider.
 *
 *   policy defaults → milestone unlocked → active campaigns → safety ceiling
 *
 * Pure and synchronous so the admin simulator, the partner app's "what have I
 * unlocked" panel and the booking gate all run the identical arithmetic. A
 * simulator that predicted with different code from the one that enforces is
 * worse than no simulator.
 */

/** The provider facts milestones are evaluated against. Read-only inputs. */
export interface ProviderStats {
  completedOrders: number;
  /** Null when a provider has no ratings yet — NOT zero. */
  rating: number | null;
  /** Percent, 0–100. Null when there are too few orders to mean anything. */
  cancellationRatePercent: number | null;
  isVerified: boolean;
  inGoodStanding: boolean;
}

export const NEW_PROVIDER_STATS: ProviderStats = {
  completedOrders: 0,
  rating: null,
  cancellationRatePercent: null,
  isVerified: false,
  inGoodStanding: true,
};

/** One traceable step, so the simulator can show its working. */
export interface EntitlementStep {
  label: string;
  dailyCapacity: number | null;
  advanceBookingDays: number;
}

export interface EffectiveEntitlement {
  /** Null means "no platform cap" — a laundromat. */
  dailyCapacity: number | null;
  advanceBookingDays: number;
  leadTimeMinutes: number;
  sameDayBookingEnabled: boolean;
  sameDayCutoffTime: string;
  bookingsEnabled: boolean;

  milestoneKey: string | null;
  milestoneName: string | null;
  appliedCampaignIds: string[];
  appliedCampaignNames: string[];
  /** True when a safety limit actually bit — the admin needs to see this. */
  cappedBySafetyLimit: boolean;
  steps: EntitlementStep[];
}

/**
 * Which milestone a provider currently satisfies. Highest rank wins; the
 * default milestone is the floor when nothing else matches.
 *
 * A null statistic never satisfies a threshold that tests it: an unrated
 * provider does not clear "rating ≥ 4.5" by having no rating.
 */
export function resolveMilestone(
  milestones: BookingMilestone[],
  stats: ProviderStats,
): BookingMilestone | null {
  const active = milestones.filter((m) => m.isActive);
  const earned = active
    .filter((m) => !m.isDefault && satisfies(m, stats))
    .sort((a, b) => b.rank - a.rank);
  if (earned.length > 0) return earned[0];

  return (
    active.find((m) => m.isDefault) ??
    // No explicit default configured: fall back to the lowest-ranked active
    // milestone rather than leaving a provider with no entitlement at all.
    active.sort((a, b) => a.rank - b.rank)[0] ??
    null
  );
}

export function satisfies(
  milestone: BookingMilestone,
  stats: ProviderStats,
): boolean {
  const e = milestone.eligibility ?? {};

  if (
    e.minCompletedOrders != null &&
    stats.completedOrders < e.minCompletedOrders
  ) {
    return false;
  }
  if (e.minRating != null) {
    if (stats.rating == null || stats.rating < e.minRating) return false;
  }
  if (e.maxCancellationRatePercent != null) {
    // A provider with no measurable cancellation rate passes: refusing her
    // would make the ceiling unreachable for anyone who has never cancelled.
    if (
      stats.cancellationRatePercent != null &&
      stats.cancellationRatePercent > e.maxCancellationRatePercent
    ) {
      return false;
    }
  }
  if (e.requireVerified && !stats.isVerified) return false;
  if (e.requireGoodStanding && !stats.inGoodStanding) return false;

  return true;
}

/** Whether a campaign covers a PH-local date and is switched on. */
export function isCampaignLive(
  campaign: BookingCampaign,
  date: string,
): boolean {
  return (
    campaign.isEnabled && campaign.startDate <= date && date <= campaign.endDate
  );
}

/** Whether a campaign's targeting includes this provider. */
export function campaignApplies(
  campaign: BookingCampaign,
  providerType: ProviderType,
  milestoneKey: string | null,
): boolean {
  const t = campaign.targeting;
  if (!t || t.scope === CampaignScope.EVERYONE) return true;
  if (t.scope === CampaignScope.PROVIDER_TYPE) {
    return t.providerType === providerType;
  }
  if (t.scope === CampaignScope.MILESTONE) {
    return milestoneKey != null && t.milestoneKeys.includes(milestoneKey);
  }
  return false;
}

function applyModifier(
  base: number,
  modifier: CampaignModifier | null | undefined,
): number {
  if (!modifier) return base;
  switch (modifier.mode) {
    case CampaignModifierMode.REPLACE:
      return Math.floor(modifier.value);
    case CampaignModifierMode.MULTIPLY:
      // Floor, never round: a ×1.5 on 5 grants 7, not 8. Capacity promises
      // should err toward what the provider can actually absorb.
      return Math.floor(base * modifier.value);
    case CampaignModifierMode.INCREASE_BY:
      return base + Math.floor(modifier.value);
    default:
      return base;
  }
}

/**
 * The whole calculation, in one place.
 *
 * `providerType` decides whether capacity applies at all: a laundromat gets
 * null capacity (self-managed) but the same timing rules as everyone else.
 */
export function resolveEntitlement(args: {
  policy: BookingPolicy | null;
  milestones: BookingMilestone[];
  campaigns: BookingCampaign[];
  stats: ProviderStats;
  providerType: ProviderType;
  /** PH-local 'YYYY-MM-DD' the entitlement is evaluated for. */
  date: string;
}): EffectiveEntitlement {
  const { policy, milestones, campaigns, stats, providerType, date } = args;

  const defaults = policy?.defaults ?? {
    dailyCapacity: POLICY_SEED.dailyCapacity,
    advanceBookingDays: POLICY_SEED.advanceBookingDays,
    leadTimeMinutes: POLICY_SEED.leadTimeMinutes,
    sameDayBookingEnabled: POLICY_SEED.sameDayBookingEnabled,
    sameDayCutoffTime: POLICY_SEED.sameDayCutoffTime,
  };
  const safety = policy?.safetyLimits ?? POLICY_SEED.safety;

  // Capacity is a home-washer concept; a laundromat's throughput is its own
  // business. Timing still applies to both.
  const capacityApplies = providerType === ProviderType.WASHER;

  const steps: EntitlementStep[] = [
    {
      label: 'Platform default',
      dailyCapacity: capacityApplies ? defaults.dailyCapacity : null,
      advanceBookingDays: defaults.advanceBookingDays,
    },
  ];

  let daily = capacityApplies ? defaults.dailyCapacity : null;
  let advance = defaults.advanceBookingDays;

  const milestone = capacityApplies
    ? resolveMilestone(milestones, stats)
    : null;
  if (milestone) {
    // NOTE: a milestone REPLACES the policy default, it does not cap it. With
    // no milestones configured (the current state) every washer inherits
    // POLICY_SEED.dailyCapacity — the platform-wide 3. The moment ANY active
    // milestone exists, resolveMilestone always returns one (falling back to
    // the default, then to the lowest-ranked), so the policy default stops
    // being reachable and the default milestone's own dailyCapacity becomes
    // the effective floor. Whoever adds the first milestone must set that
    // number deliberately, or "3 bookings per day" silently becomes whatever
    // the milestone says.
    daily = milestone.entitlements.dailyCapacity;
    advance = milestone.entitlements.advanceBookingDays;
    steps.push({
      label: `Milestone: ${milestone.name}`,
      dailyCapacity: daily,
      advanceBookingDays: advance,
    });
  }

  const live = campaigns
    .filter((c) => isCampaignLive(c, date))
    .filter((c) => campaignApplies(c, providerType, milestone?.key ?? null));

  for (const campaign of live) {
    if (daily != null) daily = applyModifier(daily, campaign.dailyCapacity);
    advance = applyModifier(advance, campaign.advanceBookingDays);
    steps.push({
      label: `Campaign: ${campaign.name}`,
      dailyCapacity: daily,
      advanceBookingDays: advance,
    });
  }

  // The backstop. Applied last so it bounds campaigns as well as milestones.
  const beforeCap = { daily, advance };
  if (daily != null) daily = Math.min(daily, safety.dailyCapacity);
  advance = Math.min(advance, safety.advanceBookingDays);

  const cappedBySafetyLimit =
    beforeCap.daily !== daily || beforeCap.advance !== advance;

  if (cappedBySafetyLimit) {
    steps.push({
      label: 'Platform safety limit',
      dailyCapacity: daily,
      advanceBookingDays: advance,
    });
  }

  return {
    dailyCapacity: daily,
    advanceBookingDays: advance,
    leadTimeMinutes: defaults.leadTimeMinutes,
    sameDayBookingEnabled: defaults.sameDayBookingEnabled,
    sameDayCutoffTime: defaults.sameDayCutoffTime,
    bookingsEnabled: policy?.enabled ?? true,
    milestoneKey: milestone?.key ?? null,
    milestoneName: milestone?.name ?? null,
    appliedCampaignIds: live.map((c) => String(c._id)),
    appliedCampaignNames: live.map((c) => c.name),
    cappedBySafetyLimit,
    steps,
  };
}

/**
 * The next milestone a provider is working toward, for the progress panel in
 * the partner app. Null when she is already at the top of the ladder.
 */
export function nextMilestone(
  milestones: BookingMilestone[],
  current: BookingMilestone | null,
): BookingMilestone | null {
  const currentRank = current?.rank ?? -1;
  return (
    milestones
      .filter((m) => m.isActive && !m.isDefault && m.rank > currentRank)
      .sort((a, b) => a.rank - b.rank)[0] ?? null
  );
}
