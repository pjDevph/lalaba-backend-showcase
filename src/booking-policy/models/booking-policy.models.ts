import { ObjectType, Field, Int, Float } from '@nestjs/graphql';

/**
 * Read models for the policy layer. None of these are stored — every one is
 * computed on read from the policy, the milestones, the live campaigns and the
 * provider's own statistics.
 */

@ObjectType()
export class EntitlementStepModel {
  @Field() label!: string;
  @Field(() => Int, { nullable: true }) dailyCapacity?: number | null;
  @Field(() => Int) advanceBookingDays!: number;
}

@ObjectType()
export class EffectiveEntitlementModel {
  /** Null = no platform cap (a laundromat manages its own throughput). */
  @Field(() => Int, { nullable: true }) dailyCapacity?: number | null;
  @Field(() => Int) advanceBookingDays!: number;
  @Field(() => Int) leadTimeMinutes!: number;
  @Field() sameDayBookingEnabled!: boolean;
  @Field() sameDayCutoffTime!: string;
  @Field() bookingsEnabled!: boolean;

  @Field(() => String, { nullable: true }) milestoneKey?: string | null;
  @Field(() => String, { nullable: true }) milestoneName?: string | null;
  @Field(() => [String]) appliedCampaignIds!: string[];
  @Field(() => [String]) appliedCampaignNames!: string[];
  @Field() cappedBySafetyLimit!: boolean;
  /** The calculation's working, for the simulator. */
  @Field(() => [EntitlementStepModel]) steps!: EntitlementStepModel[];
}

@ObjectType()
export class PolicySimulation {
  @Field() date!: string;
  @Field(() => EffectiveEntitlementModel)
  entitlement!: EffectiveEntitlementModel;
}

/**
 * How many providers a campaign reaches.
 *
 * `isEstimate` is honest rather than convenient: milestone membership is
 * derived from live statistics, so counting it exactly would mean evaluating
 * every provider — precisely the platform-wide scan this design exists to
 * avoid. Better a labelled estimate than a number that pretends otherwise.
 */
@ObjectType()
export class CampaignImpact {
  @Field(() => Int) washers!: number;
  @Field(() => Int) merchants!: number;
  @Field(() => Int) total!: number;
  @Field() isEstimate!: boolean;
}

/** The partner app's "what have I unlocked, what's next" panel. */
@ObjectType()
export class MilestoneProgress {
  @Field(() => String, { nullable: true }) currentKey?: string | null;
  @Field(() => String, { nullable: true }) currentName?: string | null;
  @Field(() => Int, { nullable: true }) currentDailyCapacity?: number | null;

  @Field(() => Int) completedOrders!: number;
  @Field(() => Float, { nullable: true }) rating?: number | null;

  @Field(() => String, { nullable: true }) nextKey?: string | null;
  @Field(() => String, { nullable: true }) nextName?: string | null;
  @Field(() => Int, { nullable: true }) nextDailyCapacity?: number | null;
  @Field(() => Int, { nullable: true }) nextAdvanceBookingDays?: number | null;

  /** Completed-order target for the next tier, when it has one. */
  @Field(() => Int, { nullable: true }) ordersRequired?: number | null;
  @Field(() => Int, { nullable: true }) ordersRemaining?: number | null;

  /** Everything still standing between her and the next tier, in plain words. */
  @Field(() => [String]) unmetRequirements!: string[];
}
