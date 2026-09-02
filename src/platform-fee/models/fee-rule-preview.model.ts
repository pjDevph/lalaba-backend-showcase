import { ObjectType, Field, Int } from '@nestjs/graphql';

/**
 * What a draft rule does to one example amount, computed by the SAME code that
 * prices real orders (computeFeeCentavos) rather than re-derived in the admin
 * UI. A preview the frontend calculates itself would agree with the backend
 * only until one of the two changed, and the whole point of the preview is to
 * catch a misconfiguration before it reaches money.
 *
 * Both sides are always returned; which one the admin should read depends on
 * `chargedTo`, and the UI shows the relevant one(s).
 */
@ObjectType()
export class FeeRulePreview {
  /** The example order/service amount the preview was computed against. */
  @Field(() => Int)
  baseCentavos!: number;

  /** The fee after min/max clamping, before allocation. */
  @Field(() => Int)
  feeCentavos!: number;

  /** The fee the rule would have produced with no min/max. */
  @Field(() => Int)
  uncappedFeeCentavos!: number;

  /** True when min/max actually changed the result — the clamp is the surprise. */
  @Field()
  minimumApplied!: boolean;

  @Field()
  maximumApplied!: boolean;

  /**
   * VAT on the fee, or 0 when applyVat is off / the fee is tax-inclusive.
   * Informational only: no pricing path adds this to an order yet.
   */
  @Field(() => Int)
  vatCentavos!: number;

  // ── Allocation ───────────────────────────────────────────────────────────
  @Field(() => Int)
  customerShareCentavos!: number;

  @Field(() => Int)
  providerShareCentavos!: number;

  /** What the customer pays: the base plus their share of the fee. */
  @Field(() => Int)
  customerTotalCentavos!: number;

  /** What the provider keeps: the base minus their share of the fee. */
  @Field(() => Int)
  providerEarningsCentavos!: number;
}
