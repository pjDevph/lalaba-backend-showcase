import { ObjectType, Field, Float } from '@nestjs/graphql';
import {
  FeeCalculationType,
  FeeChargedTo,
} from '../schemas/platform-fee-rule.schema';

/**
 * The commission a provider is on right now, in the terms their own app needs
 * to explain it to them.
 *
 * Deliberately NOT the PlatformFeeRule document. A provider has no business
 * reading another payer's rules, the rule's admin metadata (version, notes,
 * effectiveFrom, deduction source) means nothing to them, and exposing the
 * whole document from a provider-callable query is how admin surfaces leak.
 * This is the projection, and only for the caller's own provider type.
 *
 * Why `chargedTo` matters enough to add a query for: the apps used to hardcode
 * "customers pay this on top of your price". That happens to be true of both
 * seeded commission rules, but `chargedTo` is freely settable from the admin
 * page with nothing pinning COMMISSION to CUSTOMER, and the fee service already
 * prices PROVIDER. One toggle and a hardcoded app tells a provider the opposite
 * of the truth about their own money.
 */
@ObjectType()
export class EffectiveCommission {
  /** The commission rate. 10 means 10%. */
  @Field(() => Float)
  percent!: number;

  /**
   * Who actually pays it.
   *
   * CUSTOMER — added on top of the provider's price; the provider receives
   *            their price in full.
   * PROVIDER — deducted from the provider's price; the customer pays the price
   *            as listed.
   * SPLIT    — shared. The apps should show the rate and decline to guess a
   *            net figure rather than imply one.
   */
  @Field(() => FeeChargedTo)
  chargedTo!: FeeChargedTo;

  /**
   * Whether the rate above is actually the whole story. FIXED and
   * FIXED_PLUS_PERCENTAGE commissions cannot be described by a percentage
   * alone, so a client showing a computed net must fall back to the rate and
   * a plain explanation.
   */
  @Field(() => FeeCalculationType)
  calculationType!: FeeCalculationType;

  /**
   * False when no commission rule exists for this provider type and the
   * platform default is being reported instead. Clients should still show the
   * rate — it is what they will be charged — but this is the signal not to
   * present it as a configured, quotable term.
   */
  @Field()
  isConfigured!: boolean;
}
