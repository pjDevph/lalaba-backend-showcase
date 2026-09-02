import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum PromoDiscountType {
  /** `discountValue` is centavos, taken straight off the order total. */
  FLAT = 'FLAT',
  /** `discountValue` is a whole percent (1-100), applied to the order total. */
  PERCENTAGE = 'PERCENTAGE',
  /**
   * The whole amount in scope, whatever it turns out to be. `discountValue` is
   * ignored.
   *
   * Only meaningful with PLATFORM_FEE: "no Lalaba fee on this order" is a
   * promise about an amount nobody knows yet at the moment it is made, since
   * the fee is not final until the laundry is weighed. Expressing that as
   * "100 percent" would work arithmetically and read as a coincidence.
   */
  WAIVE = 'WAIVE',
}
registerEnumType(PromoDiscountType, { name: 'PromoDiscountType' });

/**
 * WHAT the discount comes off.
 *
 * Separating this from the method is what lets one engine express both halves
 * of the marketplace without a second set of tables: a customer discount comes
 * off what the customer pays, a partner incentive comes off what the platform
 * charges the provider. They are funded the same way and audited the same way;
 * only the target differs.
 *
 * Absent on every code written before this existed, and those were all order
 * discounts — so absent reads as ORDER_TOTAL and no backfill has to run before
 * the deploy.
 */
export enum PromoScope {
  /** Comes off what the customer pays. */
  ORDER_TOTAL = 'ORDER_TOTAL',
  /** Comes off the platform fee the provider owes. */
  PLATFORM_FEE = 'PLATFORM_FEE',
}
registerEnumType(PromoScope, { name: 'PromoScope' });

export type PromoCodeDocument = PromoCode & Document;

/**
 * A discount code an admin defines and a customer redeems.
 *
 * `redemptionCount` is denormalised and updated atomically alongside every
 * write to PromoRedemption — the append-only ledger is the source of truth,
 * this field exists so a usage cap can be checked with one document read
 * instead of a count() over the ledger on every redemption attempt.
 */
@ObjectType()
@Schema({ collection: 'promo_codes', timestamps: true })
export class PromoCode {
  @Field(() => ID)
  _id!: string;

  /** Always stored uppercase — codes are typed by hand, case must not matter. */
  @Field()
  @Prop({
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  })
  code!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  description!: string;

  /**
   * What the discount comes off. Nullable rather than defaulted, so a code
   * written before scopes existed is readable as what it was — an order
   * discount — without a migration having to run first. Read it through
   * `scopeOf()`, never directly.
   */
  @Field(() => PromoScope, { nullable: true })
  @Prop({ type: String, enum: PromoScope, default: null })
  scope?: PromoScope | null;

  @Field(() => PromoDiscountType)
  @Prop({ type: String, enum: PromoDiscountType, required: true })
  discountType!: PromoDiscountType;

  /** Centavos for FLAT, a whole percent (1-100) for PERCENTAGE. */
  @Field(() => Int)
  @Prop({ type: Number, required: true })
  discountValue!: number;

  /**
   * Caps a PERCENTAGE discount in absolute pesos — an uncapped "20% off" on a
   * ₱50,000 merchant order is not the same offer as it is on a ₱300 basket.
   * Ignored for FLAT, where the discount is already an absolute amount.
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  maxDiscountCentavos?: number | null;

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  minOrderValueCentavos?: number | null;

  /**
   * Which roles may redeem this. Required and non-empty for the same reason
   * a broadcast audience is: an empty or missing audience must never be
   * interpreted as "everyone" — the most permissive possible code should not
   * be the one you get by forgetting a field. Back-office roles are refused
   * at creation; there is no legitimate reason to discount an admin's order.
   */
  @Field(() => [String])
  @Prop({ type: [String], required: true })
  targetRoleIds!: string[];

  /** Only usable on a customer's first-ever completed order. */
  @Field()
  @Prop({ type: Boolean, default: false })
  firstOrderOnly!: boolean;

  /** Null = unlimited redemptions platform-wide. */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  usageCapTotal?: number | null;

  @Field(() => Int)
  @Prop({ type: Number, default: 1 })
  usageCapPerCustomer!: number;

  /**
   * How many times ONE subject may use this code — a customer, or a branch.
   *
   * Added alongside `usageCapPerCustomer` rather than renaming it: the old
   * field is on every existing code and in the admin panel's payload, and a
   * rename would be a live migration for a field that gates money. Read both
   * through `capPerSubject()`; new writes set this one.
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  usageCapPerSubject?: number | null;

  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  redemptionCount!: number;

  @Field()
  @Prop({ type: Date, required: true })
  startsAt!: Date;

  /**
   * Null = no expiry — still governed by isActive and the usage caps.
   * Explicit `() => Date`: a `Date | null` union has no reflectable design
   * type, so the implicit form fails at schema-BUILD time, past what tsc or
   * unit tests catch — only booting the app does.
   */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;

  /**
   * The admin kill switch, independent of the date window. A code can be
   * inside its active window and still be turned off — e.g. an influencer
   * partnership that ended early — without editing its dates and losing the
   * record of when it was originally meant to run.
   */
  @Field()
  @Prop({ type: Boolean, default: true })
  isActive!: boolean;

  @Field()
  @Prop({ type: String, required: true })
  createdByUid!: string;

  /** Denormalised — the record must read correctly after the admin leaves. */
  @Field()
  @Prop({ type: String, required: true })
  createdByName!: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const PromoCodeSchema = SchemaFactory.createForClass(PromoCode);
PromoCodeSchema.index({ createdAt: -1 });

/**
 * The scope of a code, including one stored before scopes existed.
 *
 * Every such code was an order discount, so absent means ORDER_TOTAL. Kept as
 * a function rather than a schema default because the default would only apply
 * to new documents, and the old ones are exactly the case this exists for.
 */
export function scopeOf(
  promo: Pick<PromoCode, 'scope'> | null | undefined,
): PromoScope {
  return promo?.scope ?? PromoScope.ORDER_TOTAL;
}

/** The per-subject cap, honouring the older per-customer field until every
 *  code has been rewritten with the newer one. */
export function capPerSubject(
  promo: Pick<PromoCode, 'usageCapPerSubject' | 'usageCapPerCustomer'>,
): number {
  return promo.usageCapPerSubject ?? promo.usageCapPerCustomer;
}
