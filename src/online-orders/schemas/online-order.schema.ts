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
import {
  BranchAddress,
  BranchAddressSchema,
  MapLocation,
  MapLocationSchema,
} from '../../branches/schemas/sub-documents.schema';
import { PricingType } from '../../services/schemas/service.schema';
import {
  OrderStatus,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  DeliverySubMode,
  ProviderType,
  PaymentMethod,
  PaymentTiming,
  LEGACY_PAYMENT_TIMING_ON_DELIVERY,
  AttemptResponsibility,
  TurnaroundTierCode,
} from './order-status.enum';

export enum QualityHoldResponse {
  PENDING = 'pending',
  APPROVED = 'approved',
  DECLINED = 'declined',
}
registerEnumType(QualityHoldResponse, { name: 'QualityHoldResponse' });

// ---------------------------------------------------------------------------
// Sub-documents / snapshots
// ---------------------------------------------------------------------------

// Privacy note (RISK-P0-009): maskedPhone/address/mapLocation are stored in
// full on the document but are GraphQL-nullable because the `customer` field
// on the order query resolves through a redacting @ResolveField — a courier
// only sees the exact address/coords while their own leg is live (same window
// as contactPhone); everyone else gets areaLabel only. Customer, provider
// owner/staff and admin/support always see the full snapshot.
@ObjectType()
export class CustomerSnapshot {
  @Field() uid!: string;
  @Field() displayName!: string;
  @Field({ nullable: true }) maskedPhone?: string;
  @Field(() => BranchAddress, { nullable: true }) address?: BranchAddress;
  @Field(() => MapLocation, { nullable: true }) mapLocation?: MapLocation;
  // Generalized "Barangay, City" line — always visible, so a courier's
  // history screen still renders a location after the leg window closes.
  @Field({ nullable: true }) areaLabel?: string;
}

@ObjectType()
export class ProviderSnapshot {
  @Field(() => ProviderType) providerType!: ProviderType;
  @Field() providerUid!: string;
  @Field() branchId!: string;
  @Field() providerName!: string;

  // Snapshotted from Branch.allowsPayAtHandover at booking, like every other
  // term of the order (platformFeePercent, service prices, turnaround SLA).
  // Read — never a live branch lookup — so a provider switching the setting off
  // cannot make a courier retract, at the doorstep, an option the customer was
  // shown when they booked. Absent on pre-feature orders ⇒ falsy ⇒ pay-now,
  // which is exactly today's behaviour, so no backfill is needed.
  @Field({ nullable: true }) allowsPayAtHandover?: boolean;
}

@ObjectType()
export class ServiceLineSnapshot {
  @Field(() => ID) serviceRefId!: string;
  @Field() serviceName!: string;
  @Field(() => PricingType) pricingType!: PricingType;
  @Field(() => Float) price!: number;
  @Field(() => Float, { nullable: true }) baseKilos?: number;
  @Field(() => Float, { nullable: true }) excessRate?: number;
  // Smallest weight this line bills for — a home washer selling per kg can
  // require a 5 kg minimum so a 2 kg booking isn't priced below her costs.
  // Snapshotted like every other pricing field so a later change can't
  // re-price a placed order.
  @Field(() => Float, { nullable: true }) minBillableKg?: number;
  @Field(() => Float) productSurchargeCentavos!: number;
  @Field(() => Float) estimatedLineTotalCentavos!: number;
  @Field(() => Float, { nullable: true }) actualLineTotalCentavos?: number;
  // Count for per-piece/per-load services; per-service handling note.
  @Field(() => Int, { nullable: true }) estimatedPieceCount?: number;
  @Field({ nullable: true }) note?: string;
}

@ObjectType()
export class OrderInstructions {
  @Field({ nullable: true }) pickupInstructions?: string;
  @Field({ nullable: true }) accessInstructions?: string;
  @Field({ nullable: true }) laundryCareInstructions?: string;
  @Field({ nullable: true }) returnInstructions?: string;
  @Field({ nullable: true }) customerGeneralNotes?: string;
  @Field({ nullable: true }) providerNotes?: string;
}

/**
 * The customer's pickup promise: a DAY, never a time.
 *
 * This used to carry a 30-minute window (startTime/endTime/label). Two things
 * killed it. A batch pickup is grouped with nearby collections, so the window
 * was never a commitment the provider could keep — and no provider surface
 * ever displayed it, so the one person meant to honour it could not see it.
 *
 * The date stays, and stays mandatory: day capacity is counted by grouping
 * orders on this field, so an order without one would consume no capacity
 * while still occupying a real place in the provider's day.
 *
 * Stored as a PH-local 'YYYY-MM-DD' key rather than a UTC instant on purpose:
 * every rule that governs it — the weekly schedule, the daily cap, the
 * same-day cutoff — is expressed in PH-local calendar terms, and a UTC
 * timestamp would drift by a day for the eight hours either side of midnight.
 */
@ObjectType()
@Schema({ _id: false })
export class ScheduledPickup {
  @Field() date!: string; // 'YYYY-MM-DD', PH-local
  /** 'Mon, Aug 18' — snapshotted so history renders without re-deriving. */
  @Field() label!: string;
}

@ObjectType()
export class OrderFulfillment {
  @Field(() => FulfillmentPickupMode) pickupMode!: FulfillmentPickupMode;
  // Pickup window tier (FREE_BATCH default / SCHEDULED_PAID) — drives the
  // snapshotted pickup fee (GAP-P0-005).
  @Field(() => DeliverySubMode, { nullable: true })
  pickupSubMode?: DeliverySubMode;
  @Field(() => FulfillmentReturnMode) returnMode!: FulfillmentReturnMode;
  @Field(() => DeliverySubMode, { nullable: true })
  deliverySubMode?: DeliverySubMode;

  // The booked handover window, validated against the provider's booking
  // availability at create time (see booking-availability module). Nullable
  // because every order placed before scheduling existed has none, and because
  // a provider with scheduled bookings switched off still takes orders.
  @Field(() => ScheduledPickup, { nullable: true })
  scheduledPickup?: ScheduledPickup | null;
}

@ObjectType()
export class OrderPricing {
  @Field(() => Float, { nullable: true }) estimatedWeightKg?: number;
  @Field(() => Float) estimatedTotalCentavos!: number;
  @Field(() => Float, { nullable: true }) actualWeightKg?: number;
  @Field(() => Int, { nullable: true }) actualPieceCount?: number;
  @Field(() => Float, { nullable: true }) actualServiceTotalCentavos?: number;
  @Field(() => Float, { nullable: true }) platformFeePercent?: number;
  @Field(() => Float, { nullable: true }) platformFeeCentavos?: number;
  // WHICH fee rule produced platformFeePercent, snapshotted alongside it. The
  // percentage alone keeps the arithmetic reproducible; these keep it
  // explicable — the exact rule version can be looked up in
  // platform_fee_rules, with its author, reason and full terms. Null on orders
  // placed before fee rules existed, or on an environment still running off
  // the legacy global config.
  // Explicit () => String: a `string | null` union has no reflectable design
  // type, so the implicit form fails at schema-build time, not compile time.
  @Field(() => String, { nullable: true }) feeRuleKey?: string | null;
  @Field(() => Int, { nullable: true }) feeRuleVersion?: number | null;
  @Field(() => Float, { nullable: true }) customerTotalCentavos?: number;

  // Server-authoritative fulfillment fees (GAP-P0-005) — snapshotted at
  // quote/create from fulfillment-pricing.util.ts and INCLUDED in
  // estimatedTotalCentavos / customerTotalCentavos. Integer centavos.
  @Field(() => Int, { nullable: true }) serviceSubtotalCentavos?: number;
  @Field(() => Int, { nullable: true }) pickupFeeCentavos?: number;
  @Field(() => Int, { nullable: true }) returnFeeCentavos?: number;
  /** Paid turnaround promise, if the customer bought one. */
  @Field(() => Int, { nullable: true }) turnaroundFeeCentavos?: number;
  // Version of the fee rule the snapshot was computed under.
  @Field({ nullable: true }) pricingRuleVersion?: string;

  // How much of platformFeeCentavos has actually been debited from the
  // provider's wallet. Normally equal to it — the base fee is consumed at
  // pickup whether or not the customer paid. They diverge when an approved
  // quality-hold surcharge raises platformFeeCentavos after pickup; the
  // difference is consumed when that surcharge is finally collected, so a
  // provider is never debited for a surcharge the customer went on to refuse.
  // Null on pre-feature orders — treated as "fully consumed if ever collected".
  @Field(() => Int, { nullable: true }) platformFeeConsumedCentavos?: number;

  /**
   * The part of `platformFeeCentavos` that came from approved quality-hold
   * surcharges, rather than from the fee rule applied to the service price.
   *
   * `platformFeeCentavos` is written by three different causes — the estimate
   * at create, the reprice once the laundry is actually weighed, and a
   * surcharge added later — and once written they are indistinguishable. That
   * is fine while the fee is simply owed, and wrong the moment any of it can
   * be waived: a promotion that means "no Lalaba fee on your first five
   * orders" must not also waive a penalty the provider incurred.
   *
   * Splitting it here rather than at the point a waiver is applied, because a
   * waiver granted at acceptance has to survive a surcharge added days later,
   * and it can only do that if the two are separable in the record.
   *
   * Cumulative, and deliberately NOT reset by finalizePricing: an approved
   * surcharge is folded into the line's actual total, so a re-weigh recomputes
   * a fee that already contains it. Zeroing this on reprice would make the
   * surcharge look like ordinary service revenue again.
   */
  @Field(() => Int, { nullable: true })
  platformFeeSurchargeCentavos?: number;

  /**
   * A platform-fee promotion applied to this order, and how much of the fee it
   * forgave.
   *
   * Recorded ALONGSIDE platformFeeCentavos, never instead of it. The fee, the
   * rate and the rule version that produced them stay exactly as the fee
   * engine calculated — overwrite the percentage to zero and the snapshot
   * becomes a lie, and no report can afterwards tell "the rule said 0%" from
   * "the rule said 10% and Lalaba paid it".
   *
   * The provider owes platformFeeCentavos minus this. Reporting can add it up
   * as what the platform gave away, which is a real cost and should never be
   * hidden inside a smaller fee.
   */
  @Field(() => ID, { nullable: true })
  platformFeePromoId?: string | null;

  @Field(() => String, { nullable: true })
  platformFeePromoCode?: string | null;

  @Field(() => Int, { nullable: true })
  platformFeeDiscountCentavos?: number;

  // Promo code applied at booking (§ self-serve checkout redemption).
  // discountCentavos is already SUBTRACTED into estimatedTotalCentavos /
  // customerTotalCentavos — never re-subtract it downstream. Null/undefined
  // on every order that didn't use a code, which is the overwhelming
  // majority — no discount fields existed before this.
  @Field(() => String, { nullable: true }) promoCode?: string | null;
  @Field(() => ID, { nullable: true }) promoId?: string | null;
  @Field(() => Int, { nullable: true }) discountCentavos?: number;
}

/**
 * The turnaround promise this order was placed under, snapshotted like every
 * other pricing fact so a provider changing their Express terms tomorrow cannot
 * rewrite what a customer already bought.
 *
 * `promisedCompletionAt` is null until the provider actually has the laundry —
 * the SLA clock starts at receipt, not at booking, so a customer choosing a
 * pickup window three days out does not eat into the provider's promised time.
 */
@ObjectType()
@Schema({ _id: false })
export class OrderTurnaround {
  @Field(() => TurnaroundTierCode)
  @Prop({
    type: String,
    enum: TurnaroundTierCode,
    default: TurnaroundTierCode.STANDARD,
  })
  tierCode!: TurnaroundTierCode;

  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  feeCentavos!: number;

  /** Null for STANDARD — no deadline is promised. */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  slaHours?: number | null;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  promisedCompletionAt?: Date | null;
}
export const OrderTurnaroundSchema =
  SchemaFactory.createForClass(OrderTurnaround);

@ObjectType()
export class PaymentSummary {
  @Field(() => PaymentMethod, { nullable: true }) method?: PaymentMethod;
  @Field({ nullable: true }) referenceId?: string;
  @Field(() => Float, { nullable: true }) amountCollectedCentavos?: number;
  @Field({ nullable: true }) collectedByUid?: string;
  // FIRST settlement. Never overwritten — several predicates read
  // `collectedAt == null` as "has this order ever been settled", and a
  // surcharge top-up at handover must not reset that to look like the
  // original collection happened days later than it did.
  @Field({ nullable: true }) collectedAt?: Date;
  // Most recent settlement. Equal to collectedAt for the common single-payment
  // order; advances when a post-collection surcharge is settled at handover.
  @Field({ nullable: true }) lastCollectedAt?: Date;
  // Cash tender/change (GAP-H-017) — optional until DECISION_REQUIRED-004
  // settles the full tender model. Integer centavos.
  @Field(() => Int, { nullable: true }) tenderedCentavos?: number;
  @Field(() => Int, { nullable: true }) changeCentavos?: number;
}

@ObjectType()
export class LegAssignment {
  @Field({ nullable: true }) assignedStaffUid?: string;
  @Field({ nullable: true }) assignedAt?: Date;
  @Field({ nullable: true }) enRouteAt?: Date;
  @Field({ nullable: true }) arrivedAt?: Date;
  @Field({ nullable: true }) completedAt?: Date;

  // Live courier location, updated by the assigned courier while the leg is in
  // progress (updateCourierLocation). Read by the customer's tracking map.
  // Carries metadata so the server can validate and the client can filter,
  // interpolate and detect staleness (see live-tracking spec §2–§4, §10).
  @Field(() => Float, { nullable: true }) locationLat?: number;
  @Field(() => Float, { nullable: true }) locationLng?: number;
  @Field({ nullable: true }) locationAt?: Date; // device recordedAt of the accepted fix
  @Field(() => Float, { nullable: true }) locationAccuracy?: number; // metres
  @Field(() => Float, { nullable: true }) locationSpeed?: number; // m/s (device), may be null
  @Field(() => Float, { nullable: true }) locationHeading?: number; // degrees, may be null
  @Field(() => Int, { nullable: true }) locationSequence?: number; // monotonic per courier device
}

@ObjectType()
export class AttemptEvidence {
  @Field(() => Int) attemptNumber!: number;
  @Field() actorUid!: string;
  @Field() timestamp!: Date;
  @Field(() => Float, { nullable: true }) gpsLat?: number;
  @Field(() => Float, { nullable: true }) gpsLng?: number;
  @Field(() => [String], { nullable: true }) photoUrls?: string[];
  @Field(() => AttemptResponsibility) responsibility!: AttemptResponsibility;
  @Field({ nullable: true }) reason?: string;
}

/**
 * Photo evidence captured at a SUCCESSFUL handover — the courier at the
 * customer's door, or staff at the counter.
 *
 * Stores object KEYS, never URLs: these frames show a customer's home and their
 * belongings, so they go to private storage behind short-lived signed reads
 * (same treatment as KYC evidence), not the public branding bucket. Reads are
 * resolved per-viewer — see the proof resolve-fields on OnlineOrdersResolver.
 *
 * Distinct from AttemptEvidence above, which documents a handover that FAILED.
 */
@ObjectType()
export class HandoverProof {
  @Field(() => [String]) objectKeys!: string[];
  @Field() capturedAt!: Date;
  @Field() capturedByUid!: string;
}

@ObjectType()
export class QualityHold {
  @Field() serviceLineIndex!: number;
  @Field({ nullable: true }) category?: string;
  @Field() reason!: string;
  @Field(() => [String], { nullable: true }) photoUrls?: string[];
  @Field() blocksOrder!: boolean; // false = documentary only, never blocked
  // Integer centavos (SEC-007) — was Float, which let a fractional-centavo
  // surcharge slip past the fee arithmetic. Also now fee-bearing: an approved
  // surcharge is charged the same platform-fee rate as the base service.
  @Field(() => Int, { nullable: true }) additionalChargeCentavos?: number;
  @Field(() => QualityHoldResponse) customerResponse!: QualityHoldResponse;
  @Field() raisedAt!: Date;
  @Field({ nullable: true }) respondTimeoutAt?: Date;
  @Field({ nullable: true }) resolvedAt?: Date;
}

export type OnlineOrderDocument = OnlineOrder & Document;

@ObjectType()
@Schema({ collection: 'online_orders', timestamps: true })
export class OnlineOrder {
  @Field(() => ID)
  _id!: string;

  /**
   * Short, human-readable, and the same reason support tickets have one:
   * nobody should have to read a Mongo ObjectId out loud on a phone call.
   * Assigned by a counter at creation — see
   * OnlineOrdersService.nextOrderNumber. Nullable and NOT unique-enforced
   * across every document — a plain unique index would collide on the first
   * two orders placed before this field existed (both have no value, which a
   * unique index treats as one shared "null"), so the index is partial: only
   * documents that actually have a string value participate, mirroring
   * WalletLedgerEntry's xenditReference index for the identical reason.
   * Orders placed before this shipped simply have none.
   */
  // Explicit type: `string | null` has no reflectable design type, so the
  // bare `@Field({ nullable: true })` form throws at schema-BUILD time.
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  orderNumber?: string | null;

  @Field(() => CustomerSnapshot)
  @Prop({ type: Object, required: true })
  customer!: CustomerSnapshot;

  @Field(() => ProviderSnapshot)
  @Prop({ type: Object, required: true })
  provider!: ProviderSnapshot;

  @Field(() => [ServiceLineSnapshot])
  @Prop({ type: [Object], required: true })
  serviceLines!: ServiceLineSnapshot[];

  @Field(() => OrderInstructions)
  @Prop({ type: Object, default: {} })
  instructions!: OrderInstructions;

  @Field(() => OrderFulfillment)
  @Prop({ type: Object, required: true })
  fulfillment!: OrderFulfillment;

  @Field(() => OrderTurnaround)
  @Prop({ type: OrderTurnaroundSchema, default: () => ({}) })
  turnaround!: OrderTurnaround;

  @Field(() => OrderPricing)
  @Prop({ type: Object, required: true })
  pricing!: OrderPricing;

  @Field(() => PaymentSummary)
  @Prop({ type: Object, default: {} })
  paymentSummary!: PaymentSummary;

  // Always ON_PICKUP under the Phase 2 contract (GAP-P0-028). The mongoose
  // enum still tolerates the legacy 'on_delivery' value so pre-hardening dev
  // orders remain loadable/saveable; GraphQL reads map it to ON_PICKUP at the
  // resolver, and no write path accepts it.
  @Field(() => PaymentTiming)
  @Prop({
    type: String,
    enum: [...Object.values(PaymentTiming), LEGACY_PAYMENT_TIMING_ON_DELIVERY],
    default: PaymentTiming.ON_PICKUP,
  })
  paymentTiming!: PaymentTiming;

  // `| null` is not decoration: @Prop declares `default: null`, so the field
  // genuinely holds null both on insert and when a leg is cleared. Omitting it
  // from the type is what forced `order.pickupAssignment = null as any`.
  @Field(() => LegAssignment, { nullable: true })
  @Prop({ type: Object, default: null })
  pickupAssignment?: LegAssignment | null;

  @Field(() => LegAssignment, { nullable: true })
  @Prop({ type: Object, default: null })
  returnAssignment?: LegAssignment | null;

  @Field(() => [AttemptEvidence])
  @Prop({ type: [Object], default: [] })
  pickupAttempts!: AttemptEvidence[];

  @Field(() => [AttemptEvidence])
  @Prop({ type: [Object], default: [] })
  deliveryAttempts!: AttemptEvidence[];

  // Proof captured when the laundry actually changed hands, per leg. Optional:
  // a shop that doesn't photograph handovers still completes orders normally.
  @Field(() => HandoverProof, { nullable: true })
  @Prop({ type: Object, default: null })
  pickupProof?: HandoverProof;

  @Field(() => HandoverProof, { nullable: true })
  @Prop({ type: Object, default: null })
  returnProof?: HandoverProof;

  @Field(() => QualityHold, { nullable: true })
  @Prop({ type: Object, default: null })
  activeQualityHold?: QualityHold;

  @Field(() => OrderStatus)
  @Prop({ type: String, enum: OrderStatus, default: OrderStatus.DRAFT })
  status!: OrderStatus;

  // Optimistic concurrency guard — every transition checks and increments
  // this so two concurrent actors can never both "win" a status change.
  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  version!: number;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  cancellationReason?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  rejectionReason?: string;

  // Set once, at the moment status flips to COMPLETED — the rating
  // window (§ratings, 30 days) anchors off this, not off updatedAt.
  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  completedAt?: Date;

  // When an unsettled order gives up waiting. Stamped by applyTransition on
  // entry to a resting state where the provider still holds the goods and the
  // customer still owes money, re-stamped on each redelivery cycle so an
  // attempt never inherits an already-expired clock, and cleared on the way
  // out. Null whenever nothing is owed: a fully-paid order sitting uncollected
  // is a storage problem, not an unsettled one, and abandoning it would strand
  // laundry the customer has already bought.
  // Explicit () => Date for the same reason feeRuleKey needs () => String: a
  // `Date | null` union has no reflectable design type, so the implicit form
  // fails when the schema is BUILT, not when it is compiled.
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  abandonmentDeadlineAt?: Date | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const OnlineOrderSchema = SchemaFactory.createForClass(OnlineOrder);
// Partial: only documents with a real orderNumber participate, so orders
// placed before this field existed (all sharing an absent value) don't
// collide with each other on the unique constraint.
OnlineOrderSchema.index(
  { orderNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { orderNumber: { $type: 'string' } },
  },
);
OnlineOrderSchema.index({ 'customer.uid': 1, createdAt: -1 });
OnlineOrderSchema.index({ 'provider.branchId': 1, status: 1, createdAt: -1 });
OnlineOrderSchema.index({ 'pickupAssignment.assignedStaffUid': 1, status: 1 });
OnlineOrderSchema.index({ 'returnAssignment.assignedStaffUid': 1, status: 1 });
// Booking-capacity counts run per provider per booked date on every slot list
// the customer app renders, so this one is on the hot path, not a report.
OnlineOrderSchema.index({
  'provider.branchId': 1,
  'fulfillment.scheduledPickup.date': 1,
  status: 1,
});
// The abandonment sweep runs hourly against the whole collection; sparse
// because only unsettled orders resting with the provider carry a deadline.
OnlineOrderSchema.index(
  { abandonmentDeadlineAt: 1, status: 1 },
  { sparse: true },
);
