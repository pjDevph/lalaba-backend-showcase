import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

/**
 * A washer's own performance over a date range.
 *
 * Distinct from `washerStats`, which is a live "right now" snapshot with no
 * window (slots used today, active orders). This is the retrospective view the
 * Reports screen renders, and it is the only place a washer sees money.
 *
 * MONEY IS INFORMATIONAL. Customers pay the washer DIRECTLY — Lalaba never
 * holds the funds and there is no payout — so `grossCentavos` is what she
 * should have collected, not what anyone owes her. `platformFeeCentavos` is the
 * only figure Lalaba actually moves, and it is deducted from her prepaid fee
 * wallet as orders complete. This is why `netCentavos` is presented as
 * "what you kept" rather than a balance.
 *
 * Everything is integer centavos, matching the order pricing snapshot it is
 * summed from. Reading the SNAPSHOT rather than recomputing from current rates
 * is deliberate: a fee-rule change must never retroactively rewrite what a
 * completed order cost.
 */
@ObjectType()
export class WasherReport {
  /** Inclusive window, YYYY-MM-DD in PH time — echoed back so the UI can label
   *  the figures with the range they actually cover. */
  @Field()
  dateFrom!: string;

  @Field()
  dateTo!: string;

  @Field(() => Int)
  ordersCompleted!: number;

  /** Cancelled or rejected. Shown because a rising count is the earliest signal
   *  a washer is over-committing, which no other screen surfaces. */
  @Field(() => Int)
  ordersCancelled!: number;

  /** Sum of what customers paid her, from each completed order's snapshot. */
  @Field(() => Int)
  grossCentavos!: number;

  /** Sum of platform fees on those orders — charged to her fee wallet. */
  @Field(() => Int)
  platformFeeCentavos!: number;

  /** grossCentavos − platformFeeCentavos. Precomputed so the app never
   *  re-derives money and cannot disagree with this number. */
  @Field(() => Int)
  netCentavos!: number;

  @Field(() => Float, { nullable: true })
  totalKg?: number | null;

  /** Null when nothing in the window was rated — NOT 0, which would read as
   *  "rated one star". */
  @Field(() => Float, { nullable: true })
  avgRating?: number | null;

  @Field(() => Int)
  reviewCount!: number;
}
