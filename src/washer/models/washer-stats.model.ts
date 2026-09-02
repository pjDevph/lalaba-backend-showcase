import { ObjectType, Field, Float, Int } from '@nestjs/graphql';

// Operational stats only — every number here derives from the canonical
// online_orders collection (read-only aggregation by provider.providerUid)
// or the washer's own profile ratingAggregate. Money aggregates that used to
// live here (totalEarningsThisMonth / pendingEarnings) were tied to the
// legacy washer_earnings collection and were removed with GAP-P0-011; the
// consumable wallet (no withdrawals) is the only money surface in Phase 2.
@ObjectType()
export class WasherStats {
  // Orders counted against today's daily cap — same semantics as
  // OnlineOrdersService.assertWasherUnderDailyCap: created today (PH time),
  // any status except cancelled / rejected_by_provider.
  @Field(() => Int)
  slotsUsedToday!: number;

  // In-flight jobs: accepted by this washer and not yet terminal.
  @Field(() => Int)
  activeOrders!: number;

  // Lifetime completed online orders.
  @Field(() => Int)
  completedOrders!: number;

  // Orders whose status flipped to COMPLETED today (PH time).
  @Field(() => Int)
  completedOrdersToday!: number;

  // Lifetime laundry weight processed across completed orders (actual kg,
  // falling back to estimate) and loads handled (one per service line).
  @Field(() => Float)
  totalKg!: number;

  @Field(() => Int)
  totalLoads!: number;

  @Field(() => Float, { nullable: true })
  avgRating?: number;

  @Field(() => Int)
  totalReviews!: number;
}
