import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { PromoDiscountType } from '../schemas/promo-code.schema';
import { UserVoucherStatus } from '../schemas/user-voucher.schema';

/**
 * A held voucher as its holder needs to see it: the entitlement flattened
 * together with the terms of the promotion behind it, and a status worked out
 * at read time.
 *
 * A view model rather than the stored document, because half of what the
 * holder cares about — is it still usable, how many uses are left, when does
 * it expire — lives on the promotion, not on the claim.
 */
@ObjectType()
export class UserVoucherView {
  @Field(() => ID) _id!: string;
  @Field(() => ID) promoId!: string;
  @Field() code!: string;
  @Field() description!: string;

  @Field(() => PromoDiscountType) discountType!: PromoDiscountType;
  @Field(() => Int) discountValue!: number;
  @Field(() => Int, { nullable: true }) maxDiscountCentavos!: number | null;
  @Field(() => Int, { nullable: true }) minOrderValueCentavos!: number | null;

  @Field(() => Date, { nullable: true }) expiresAt!: Date | null;
  @Field(() => Date) claimedAt!: Date;

  /** How many more times THIS holder may use it. Zero reads as USED. */
  @Field(() => Int) usesRemaining!: number;

  @Field(() => UserVoucherStatus) status!: UserVoucherStatus;

  /**
   * Can this be used on the order being asked about?
   *
   * Answered by the SAME validate() that runs at checkout, so a voucher the
   * picker offers cannot be refused a moment later, and one it disables cannot
   * turn out to have been fine. Without an order to ask about, this reflects
   * only whether the voucher is live — there is nothing yet to be eligible
   * for.
   *
   * The app renders this answer rather than deriving one. Half the rules are
   * unknowable client-side anyway: "first order only" needs the order history,
   * and the per-customer cap needs the redemption ledger.
   */
  @Field() usable!: boolean;

  /** Why not, in words meant for the person holding it. Null when usable. */
  @Field(() => String, { nullable: true }) unusableReason!: string | null;

  /**
   * What it would take off THIS order. Null when there is no order in
   * question, or when it cannot be used.
   *
   * A preview for the list only — the server recalculates at checkout and the
   * app never sends an amount. Showing it here is how someone picks between
   * two vouchers without doing percentage arithmetic in their head.
   */
  @Field(() => Int, { nullable: true }) discountPreviewCentavos!: number | null;
}
