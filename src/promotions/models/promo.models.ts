import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { PromoCode } from '../schemas/promo-code.schema';
import { PromoRedemption } from '../schemas/promo-redemption.schema';

@ObjectType()
export class PaginatedPromoCodes {
  @Field(() => [PromoCode]) data!: PromoCode[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}

/**
 * The answer to "would this code work right now, for this person" — computed
 * without side effects, so the admin panel can preview a code before it goes
 * live, and a future checkout integration can check eligibility before
 * showing "apply" as available.
 */
@ObjectType()
export class PromoValidation {
  @Field()
  valid!: boolean;

  /**
   * Human-readable reason when `valid` is false. Null when valid.
   * Explicit `() => String`: a `string | null` union has no reflectable
   * design type, so the implicit form fails at schema-BUILD time — past
   * what tsc or unit tests catch, only booting the app does.
   */
  @Field(() => String, { nullable: true })
  reason?: string | null;

  /** What this code would actually take off the order, in centavos. */
  @Field(() => Int)
  discountCentavos!: number;
}

@ObjectType()
export class PromoRedeemer {
  @Field(() => ID) customerUid!: string;
  @Field() customerName!: string;
  @Field(() => Int) redemptionCount!: number;
}

/**
 * A day's worth of redemptions — the shape an admin actually eyeballs for a
 * spike. A single number ("47 total redemptions") cannot show that 40 of
 * them landed in one hour; a day-by-day count can.
 */
@ObjectType()
export class PromoRedemptionsByDay {
  @Field() date!: string;
  @Field(() => Int) count!: number;
}

@ObjectType()
export class PromoUsageSummary {
  @Field(() => Int)
  totalRedemptions!: number;

  @Field(() => Int)
  uniqueCustomers!: number;

  @Field(() => Int)
  totalDiscountCentavos!: number;

  /** Last 14 days, oldest first. */
  @Field(() => [PromoRedemptionsByDay])
  byDay!: PromoRedemptionsByDay[];

  /**
   * Customers who redeemed more times than usageCapPerCustomer allows.
   *
   * Should always be empty — `redeem` enforces the per-customer cap before
   * writing. A non-empty list here means the cap was bypassed somehow (a
   * direct database write, a bug in an older version of this check), which
   * makes it worth surfacing as an integrity signal rather than quietly
   * trusting the enforcement path.
   */
  @Field(() => [PromoRedeemer])
  overCapCustomers!: PromoRedeemer[];

  @Field(() => [PromoRedemption])
  recentRedemptions!: PromoRedemption[];
}
