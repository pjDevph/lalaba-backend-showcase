import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Where a redemption is in its life.
 *
 * There was no lifecycle at all before this: a redemption row was written the
 * moment an order was created, the usage counter was incremented, and nothing
 * could ever undo either. So a customer who applied a code to an order the
 * provider then REJECTED lost the code permanently — the global cap and their
 * own per-customer cap were both consumed by an order that never existed.
 *
 * RESERVED holds the slot while the order is in flight. It still counts
 * against every cap, so this cannot be used to over-issue; it just becomes
 * releasable if the order dies.
 */
export enum PromoRedemptionStatus {
  /** Held against a live order. Counts against caps. */
  RESERVED = 'RESERVED',
  /** The order completed, or an admin granted it directly. Final. */
  REDEEMED = 'REDEEMED',
  /** The order was rejected or cancelled — the slot went back. */
  RELEASED = 'RELEASED',
}
registerEnumType(PromoRedemptionStatus, { name: 'PromoRedemptionStatus' });

/**
 * WHO the cap is counted against.
 *
 * For a customer that is their account. For a provider it is the BRANCH, not
 * the owner's login: "first five orders with no platform fee" is a promise
 * about a shop, and a merchant with three branches would otherwise get five
 * between them — or five each, depending on which id happened to be used.
 * Naming the subject makes that a decision rather than an accident.
 *
 * Washers key on branchId too. A washer's anchor branch already stands in for
 * her everywhere else money is involved (it is what her wallet is keyed on),
 * so a separate washer-profile subject would be a second name for the same
 * thing.
 */
export enum RedemptionSubjectType {
  CUSTOMER = 'CUSTOMER',
  BRANCH = 'BRANCH',
}
registerEnumType(RedemptionSubjectType, { name: 'RedemptionSubjectType' });

export type PromoRedemptionDocument = PromoRedemption & Document;

/**
 * One redemption of one code, append-only.
 *
 * This is the ledger `PromoCode.redemptionCount` is a running total OF — the
 * same "denormalised count backed by an append-only source of truth" pattern
 * the wallet ledger uses, for the same reason: a usage cap enforced only
 * against a counter that can be edited by hand is not actually enforced, and
 * "who used this code and when" has to survive independently of whatever the
 * counter currently says.
 */
@ObjectType()
@Schema({
  collection: 'promo_redemptions',
  timestamps: { createdAt: true, updatedAt: false },
})
export class PromoRedemption {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true, index: true })
  promoId!: string;

  /** Denormalised so the redemption list reads without a join. */
  @Field()
  @Prop({ type: String, required: true })
  code!: string;

  /**
   * The customer, on a customer redemption.
   *
   * Still required, and still what the per-customer cap counts, so every row
   * written before subjects existed keeps working untouched. A branch
   * redemption stores the provider's owner uid here — the field means "who
   * acted", and `subjectId` means "who the cap is charged to".
   */
  @Field()
  @Prop({ type: String, required: true, index: true })
  customerUid!: string;

  /** Absent on rows written before subjects existed — those are all customer
   *  redemptions, which is what `subjectTypeOf()` returns for them. */
  @Field(() => RedemptionSubjectType, { nullable: true })
  @Prop({ type: String, enum: RedemptionSubjectType, default: null })
  subjectType?: RedemptionSubjectType | null;

  /** The branch id on a BRANCH redemption. Null on legacy rows, where the
   *  subject is the customer and `customerUid` already carries it. */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  subjectId?: string | null;

  @Field()
  @Prop({ type: String, required: true })
  customerName!: string;

  /**
   * The order this discount was applied to, where one exists. Nullable
   * because a redemption can be recorded (e.g. a support goodwill gesture)
   * without a live checkout integration supplying an order id yet.
   */
  @Field(() => ID, { nullable: true })
  @Prop({ type: String, default: null })
  orderId?: string | null;

  @Field(() => Int)
  @Prop({ type: Number, required: true })
  discountAppliedCentavos!: number;

  /**
   * Absent on rows written before the lifecycle existed. Those are historical
   * and final, so they read as REDEEMED — which is also why every cap query
   * below matches on "not RELEASED" rather than "is REDEEMED": a `$ne` match
   * includes documents where the field is missing, so legacy rows keep
   * counting exactly as they always did.
   */
  @Field(() => PromoRedemptionStatus, { nullable: true })
  @Prop({ type: String, enum: PromoRedemptionStatus, default: null })
  status?: PromoRedemptionStatus | null;

  /** When the slot was handed back. Only set on RELEASED rows.
   *  Explicit `() => Date`: a `Date | null` union has no reflectable design
   *  type, so the implicit form fails at schema-BUILD time, not compile time —
   *  the same trap already documented on OnlineOrder.feeRuleKey. */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  releasedAt?: Date | null;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const PromoRedemptionSchema =
  SchemaFactory.createForClass(PromoRedemption);
PromoRedemptionSchema.index({ promoId: 1, createdAt: -1 });
PromoRedemptionSchema.index({ promoId: 1, customerUid: 1 });
// The release/settle path looks a redemption up by the order it belongs to.
PromoRedemptionSchema.index({ orderId: 1 });
/** The per-branch cap count. */
PromoRedemptionSchema.index({ promoId: 1, subjectId: 1 });

/** Legacy rows carry no subject, and every one of them was a customer. */
export function subjectTypeOf(
  row: Pick<PromoRedemption, 'subjectType'> | null | undefined,
): RedemptionSubjectType {
  return row?.subjectType ?? RedemptionSubjectType.CUSTOMER;
}
