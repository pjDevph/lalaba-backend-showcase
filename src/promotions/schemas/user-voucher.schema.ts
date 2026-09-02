import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { RedemptionSubjectType } from './promo-redemption.schema';

/**
 * What a held voucher looks like to the person holding it.
 *
 * DERIVED, never stored — see `voucherStatusOf`. A stored status would be a
 * second state machine describing the same facts as the redemption ledger, and
 * the two would drift the first time an order was cancelled by a path that
 * forgot to update it. The ledger already knows how many times this subject
 * has used this code; the promo already knows whether it is live. Storing an
 * answer derived from both only creates somewhere for them to disagree.
 *
 * The same reasoning the promo list page already follows with computeStatus,
 * and booking entitlements before that.
 */
export enum UserVoucherStatus {
  /** Held and usable right now. */
  AVAILABLE = 'AVAILABLE',
  /** This holder has used it as many times as they may. */
  USED = 'USED',
  /** The promotion itself has ended, been exhausted, or been switched off. */
  EXPIRED = 'EXPIRED',
  /** Taken back by an admin. */
  REVOKED = 'REVOKED',
}
registerEnumType(UserVoucherStatus, { name: 'UserVoucherStatus' });

export type UserVoucherDocument = UserVoucher & Document;

/**
 * "This person holds this code."
 *
 * Entitlement and distribution only — it does not compute money and it is not
 * consulted when a discount is calculated. Checkout still goes through
 * PromotionsService.validate(), so a claimed voucher and a typed code are the
 * same thing by the time anything financial happens. Claiming just means the
 * customer no longer has to know the code.
 */
@ObjectType()
@Schema({ collection: 'user_vouchers', timestamps: true })
export class UserVoucher {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true, index: true })
  promoId!: string;

  /** Denormalised so "My Vouchers" renders without a join. */
  @Field()
  @Prop({ type: String, required: true })
  code!: string;

  @Field(() => RedemptionSubjectType)
  @Prop({
    type: String,
    enum: RedemptionSubjectType,
    default: RedemptionSubjectType.CUSTOMER,
  })
  subjectType!: RedemptionSubjectType;

  /** The customer's uid, or a branch id for a partner entitlement. */
  @Field()
  @Prop({ type: String, required: true, index: true })
  subjectId!: string;

  @Field()
  @Prop({ type: Date, default: () => new Date() })
  claimedAt!: Date;

  /** Set when an admin takes it back. Kept rather than deleting the row, so
   *  "I had a voucher and it vanished" has an answer. */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  revokedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  createdAt?: Date;
}

export const UserVoucherSchema = SchemaFactory.createForClass(UserVoucher);

/**
 * One entitlement per holder per promotion — enforced by the database.
 *
 * This is the claim's idempotency. Two taps on CLAIM, or a retried request,
 * produce one row because the index makes a second impossible, not because the
 * button was disabled fast enough. UI debounce is a race the client sometimes
 * wins.
 */
UserVoucherSchema.index(
  { promoId: 1, subjectType: 1, subjectId: 1 },
  { unique: true },
);

/** The "My Vouchers" list. */
UserVoucherSchema.index({ subjectId: 1, claimedAt: -1 });
