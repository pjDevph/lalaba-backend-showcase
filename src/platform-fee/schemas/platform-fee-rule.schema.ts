import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Who the rule applies to. The two provider values reuse ProviderType's string
 * values ('washer' / 'merchant') on purpose — a fee lookup for an order is
 * `payerRoleForProviderType(order.providerType)` with no mapping table, and a
 * typo shows up as a compile error rather than a silently-unmatched rule.
 */
export enum FeePayerRole {
  CUSTOMER = 'customer',
  HOME_WASHER = 'washer',
  LAUNDROMAT = 'merchant',
  COURIER = 'courier',
}
registerEnumType(FeePayerRole, { name: 'FeePayerRole' });

/**
 * What kind of charge this is. The category — not the rule's name, which is
 * admin-editable free text — is what the pricing code matches on, so adding a
 * value here is a backend change, not a config change.
 *
 * ACTIVATION_MINIMUM / ACCEPT_MINIMUM are not charges: they are the wallet
 * balance thresholds a provider must hold (₱1,000 to onboard, ₱100 to keep
 * accepting bookings — see wallet.constants.ts). They live here because they
 * are the same "money rule an admin needs to change without a deploy", and
 * because showing them next to the commissions is what makes the page a
 * complete answer to "what does it cost to be on Lalaba".
 */
export enum FeeCategory {
  COMMISSION = 'commission',
  BOOKING_FEE = 'booking_fee',
  SURCHARGE = 'surcharge',
  ACTIVATION_MINIMUM = 'activation_minimum',
  ACCEPT_MINIMUM = 'accept_minimum',
  OTHER = 'other',
}
registerEnumType(FeeCategory, { name: 'FeeCategory' });

export enum FeeCalculationType {
  FIXED = 'fixed',
  PERCENTAGE = 'percentage',
  FIXED_PLUS_PERCENTAGE = 'fixed_plus_percentage',
}
registerEnumType(FeeCalculationType, { name: 'FeeCalculationType' });

/** What the percentage is taken from, or what a fixed amount is charged per. */
export enum FeeBasis {
  SERVICE_SUBTOTAL = 'service_subtotal',
  ORDER_SUBTOTAL = 'order_subtotal',
  PER_ORDER = 'per_order',
  PER_BOOKING = 'per_booking',
  PER_TRANSACTION = 'per_transaction',
  PER_DELIVERY = 'per_delivery',
  PER_PROVIDER = 'per_provider',
  ONE_TIME_ACTIVATION = 'one_time_activation',
}
registerEnumType(FeeBasis, { name: 'FeeBasis' });

export enum FeeChargedTo {
  CUSTOMER = 'customer',
  PROVIDER = 'provider',
  SPLIT = 'split',
}
registerEnumType(FeeChargedTo, { name: 'FeeChargedTo' });

/**
 * Where the money is actually taken from. NOT_DEDUCTED is the honest value for
 * a customer-paid fee (nothing is deducted from anyone — it is added to what
 * the customer owes) and for the wallet minimums (the balance stays the
 * provider's). MAIN_WALLET is the only wallet today: Wallet has a single
 * balanceCentavos, so a separate fee wallet does not exist yet.
 */
export enum FeeDeductionSource {
  ORDER_SETTLEMENT = 'order_settlement',
  MAIN_WALLET = 'main_wallet',
  SEPARATE_INVOICE = 'separate_invoice',
  NOT_DEDUCTED = 'not_deducted',
}
registerEnumType(FeeDeductionSource, { name: 'FeeDeductionSource' });

export enum FeeTaxTreatment {
  TAX_INCLUSIVE = 'tax_inclusive',
  TAX_EXCLUSIVE = 'tax_exclusive',
}
registerEnumType(FeeTaxTreatment, { name: 'FeeTaxTreatment' });

export type PlatformFeeRuleDocument = PlatformFeeRule & Document;

/**
 * One VERSION of one fee rule. The collection is append-only: editing a rule
 * inserts a new document sharing the previous `ruleKey` with `version + 1`,
 * and the "current" rule is the newest version whose effective window contains
 * now. Nothing is ever updated in place, so:
 *
 *   - an order's snapshot (OnlineOrder.pricing.feeRuleKey/feeRuleVersion) always
 *     resolves to the exact terms it was priced under, even years later;
 *   - the change history on the admin page is the collection itself, not a
 *     separate audit table that could drift out of sync;
 *   - a rate change can be SCHEDULED by inserting a version with a future
 *     effectiveFrom, which the resolver simply won't pick up until that date.
 *
 * This is the same append-only shape as the legacy PlatformFeeConfig it
 * replaces, widened from one global percentage to a payer-scoped rule.
 *
 * Deliberately NOT modelled yet (deferred, see the admin page's own notes):
 * day/time conditions, special-date overrides, per-service scoping, waivers.
 * `stackable` and the tax fields ARE stored so the terms an admin agreed to are
 * recorded, but no pricing path reads them yet — see resolveFeeRules().
 */
@ObjectType()
@Schema({
  collection: 'platform_fee_rules',
  timestamps: { createdAt: true, updatedAt: false },
})
export class PlatformFeeRule {
  @Field(() => ID)
  _id!: string;

  /**
   * Stable identity across versions — a slug derived from the name on create
   * and immutable thereafter. Renaming a rule keeps its key, so its history
   * and any order snapshots referencing it stay attached.
   */
  @Field()
  @Prop({ required: true })
  ruleKey!: string;

  @Field(() => Int)
  @Prop({ required: true, min: 1 })
  version!: number;

  @Field()
  @Prop({ required: true, trim: true })
  name!: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  description?: string;

  @Field(() => FeePayerRole)
  @Prop({ required: true, enum: FeePayerRole })
  appliesTo!: FeePayerRole;

  @Field(() => FeeCategory)
  @Prop({ required: true, enum: FeeCategory })
  category!: FeeCategory;

  // ── Calculation ──────────────────────────────────────────────────────────
  @Field(() => FeeCalculationType)
  @Prop({ required: true, enum: FeeCalculationType })
  calculationType!: FeeCalculationType;

  /** Required unless calculationType is FIXED. */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0, max: 100 })
  percent?: number | null;

  /** Required unless calculationType is PERCENTAGE. Integer centavos. */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  fixedAmountCentavos?: number | null;

  @Field(() => FeeBasis)
  @Prop({ required: true, enum: FeeBasis })
  basis!: FeeBasis;

  /** Floor/ceiling on the computed fee. Null = unbounded. Integer centavos. */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  minFeeCentavos?: number | null;

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  maxFeeCentavos?: number | null;

  // ── Allocation ───────────────────────────────────────────────────────────
  @Field(() => FeeChargedTo)
  @Prop({ required: true, enum: FeeChargedTo })
  chargedTo!: FeeChargedTo;

  /** Both required, and must total 100, when chargedTo is SPLIT. */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0, max: 100 })
  customerSharePercent?: number | null;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0, max: 100 })
  providerSharePercent?: number | null;

  @Field(() => FeeDeductionSource)
  @Prop({ required: true, enum: FeeDeductionSource })
  deductFrom!: FeeDeductionSource;

  // ── Tax ──────────────────────────────────────────────────────────────────
  // Recorded, not yet applied by any pricing path. Stored because "10%" is
  // ambiguous about VAT and the ambiguity is what causes the disputes; an
  // admin who sets these has stated the intent even before the math honours it.
  @Field(() => FeeTaxTreatment)
  @Prop({
    required: true,
    enum: FeeTaxTreatment,
    default: FeeTaxTreatment.TAX_INCLUSIVE,
  })
  taxTreatment!: FeeTaxTreatment;

  @Field()
  @Prop({ type: Boolean, default: false })
  applyVat!: boolean;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0, max: 100 })
  vatRatePercent?: number | null;

  /**
   * Whether this fee adds on top of other fees in its category or replaces
   * them. Recorded now; only meaningful once overlapping rules exist (day/time
   * and special-date overrides are deferred), so today every category resolves
   * to at most one active rule per payer and nothing stacks.
   */
  @Field()
  @Prop({ type: Boolean, default: true })
  stackable!: boolean;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  @Field()
  @Prop({ type: Boolean, default: true })
  isActive!: boolean;

  @Field()
  @Prop({ required: true })
  effectiveFrom!: Date;

  /** Null = no end date. Explicit () => Date — a `Date | null` union is not reflectable. */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  effectiveUntil?: Date | null;

  /** Set when a later version supersedes this one — purely for rendering history. */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  supersededByVersion?: number | null;

  // ── Provenance ───────────────────────────────────────────────────────────
  @Field()
  @Prop({ required: true })
  setByUid!: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  setByName?: string;

  /** Admin's stated reason for this version. Required for rate changes. */
  @Field({ nullable: true })
  @Prop({ default: null })
  changeReason?: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const PlatformFeeRuleSchema =
  SchemaFactory.createForClass(PlatformFeeRule);

// One document per (rule, version) — makes a concurrent double-publish of the
// same version an E11000 rather than two conflicting "current" rules.
PlatformFeeRuleSchema.index({ ruleKey: 1, version: -1 }, { unique: true });
// The resolution query: active rules for a payer+category, newest effective first.
PlatformFeeRuleSchema.index({ appliesTo: 1, category: 1, effectiveFrom: -1 });
