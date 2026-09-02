import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

/**
 * BOOKING AVAILABILITY — deliberately NOT the same thing as operating hours.
 *
 *   OperatingHours (branches/sub-documents.schema.ts)
 *     "When is my laundry business operating?"      → drives "Open until 8 PM"
 *              ↓
 *   BookingAvailabilityConfig (this file)
 *     "When am I willing to accept customer bookings?"
 *              ↓
 *   Capacity (dailyBookingLimit)
 *     "How many bookings can I actually handle?"
 *
 * A provider can be open 8 AM–10 PM, accept bookings only 8 AM–6 PM, run
 * pickups only 9 AM–5 PM, and still cap the day at 20 orders. Collapsing those
 * into one schedule — which is what deriving pickup slots straight from
 * operating hours did — cannot express any of it.
 *
 * Keyed by branchId for BOTH provider types: a WasherProfile carries a
 * branchId anchor (see washer-profile.schema.ts), so one config collection
 * serves laundromat branches and home washers without a polymorphic key.
 *
 * OWNERSHIP: this document is the PROVIDER's — her weekly schedule, her chosen
 * capacity, her pause switch. What she is ALLOWED is not stored here at all; it
 * is computed per read from the platform Booking Policy (see src/booking-policy):
 *
 *   policy defaults → milestone unlocked → live campaigns → safety ceiling
 *
 * Effective capacity is min(what she asked for, what she is entitled to). That
 * split is what lets a platform-wide promo change a million providers' limits
 * by editing ONE campaign record, while a provider can still throttle herself
 * down on a busy week.
 */

/** How a customer hands laundry over — availability may differ per mode. */
export enum FulfillmentOption {
  PICKUP_AND_DELIVERY = 'pickup_and_delivery',
  CUSTOMER_DROPOFF = 'customer_dropoff',
  CUSTOMER_PICKUP = 'customer_pickup',
}
registerEnumType(FulfillmentOption, { name: 'FulfillmentOption' });

/**
 * The window a provider's own schedule falls back to when she has never set
 * one. Every OTHER default — capacity, interval, lead time, advance window,
 * same-day cutoff — now comes from the platform Booking Policy, so there is no
 * second set of numbers here to drift from it.
 */
export const DEFAULT_WINDOW_OPEN = '08:00';
export const DEFAULT_WINDOW_CLOSE = '20:00';

// ── Sub-documents ──────────────────────────────────────────────────────────

/**
 * One bookable window. Separate from branches' `TimeSlot` (open/close) on
 * purpose: this is a booking window, and reusing the operating-hours shape
 * would re-fuse the two concepts the module exists to separate.
 */
@ObjectType()
@Schema({ _id: false })
export class BookingWindow {
  @Field() @Prop({ required: true }) start!: string; // 'HH:MM', PH-local
  @Field() @Prop({ required: true }) end!: string; // 'HH:MM', PH-local
}
export const BookingWindowSchema = SchemaFactory.createForClass(BookingWindow);

/**
 * Which handover modes a day supports, and optionally their own narrower
 * windows. Empty window arrays mean "same as the day's booking windows" — the
 * common case, so a provider isn't forced to restate the schedule three times.
 *
 * The two provider-performed legs are configured INDEPENDENTLY. They used to
 * share a single `pickupAndDelivery` flag, which made a merchant's real
 * offerings inexpressible: "rider collects, customer collects it back" and
 * "customer drops off, rider delivers" both need one leg on and the other off.
 * `legacyPickupAndDelivery` is the retired field, read only by the migration
 * shim in `dayFulfillmentOf()` — never write it.
 */
@ObjectType()
@Schema({ _id: false })
export class DayFulfillment {
  /** Inbound: provider/courier collects from the customer. */
  @Field() @Prop({ default: true }) providerPickup!: boolean;
  /** Outbound: provider/courier returns to the customer. */
  @Field() @Prop({ default: true }) providerDelivery!: boolean;
  @Field() @Prop({ default: true }) customerDropoff!: boolean;
  @Field() @Prop({ default: true }) customerPickup!: boolean;
}
export const DayFulfillmentSchema =
  SchemaFactory.createForClass(DayFulfillment);

/**
 * A single weekday's booking rules. A null number inherits the provider-level
 * value, which in turn inherits her platform entitlement — so a provider who
 * wants one number all week sets it once, and a Saturday that genuinely differs
 * overrides only Saturday. `null` means "inherit", never "no limit".
 */
@ObjectType()
@Schema({ _id: false })
export class DayBookingConfig {
  @Field() @Prop({ default: true }) isAcceptingBookings!: boolean;

  @Field(() => [BookingWindow])
  @Prop({ type: [BookingWindowSchema], default: [] })
  windows!: BookingWindow[];

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  dailyBookingLimit?: number | null;

  @Field(() => DayFulfillment)
  @Prop({ type: DayFulfillmentSchema, default: () => ({}) })
  fulfillment!: DayFulfillment;
}
export const DayBookingConfigSchema =
  SchemaFactory.createForClass(DayBookingConfig);

@ObjectType()
@Schema({ _id: false })
export class WeeklyBookingSchedule {
  @Field(() => DayBookingConfig)
  @Prop({ type: DayBookingConfigSchema, default: () => ({}) })
  monday!: DayBookingConfig;
  @Field(() => DayBookingConfig)
  @Prop({ type: DayBookingConfigSchema, default: () => ({}) })
  tuesday!: DayBookingConfig;
  @Field(() => DayBookingConfig)
  @Prop({ type: DayBookingConfigSchema, default: () => ({}) })
  wednesday!: DayBookingConfig;
  @Field(() => DayBookingConfig)
  @Prop({ type: DayBookingConfigSchema, default: () => ({}) })
  thursday!: DayBookingConfig;
  @Field(() => DayBookingConfig)
  @Prop({ type: DayBookingConfigSchema, default: () => ({}) })
  friday!: DayBookingConfig;
  @Field(() => DayBookingConfig)
  @Prop({ type: DayBookingConfigSchema, default: () => ({}) })
  saturday!: DayBookingConfig;
  @Field(() => DayBookingConfig)
  @Prop({ type: DayBookingConfigSchema, default: () => ({}) })
  sunday!: DayBookingConfig;
}
export const WeeklyBookingScheduleSchema = SchemaFactory.createForClass(
  WeeklyBookingSchedule,
);

// ── Root document ──────────────────────────────────────────────────────────

export type BookingAvailabilityConfigDocument = BookingAvailabilityConfig &
  Document;

/**
 * What a provider charges for ONE fulfillment leg.
 *
 * A request, not an entitlement — the effective amount is
 * `min(this, policy.safetyLimits.maxLegFeeCentavos)`, resolved at order time by
 * `fulfillment-pricing.util.ts`. Lowering the platform ceiling therefore takes
 * effect on the next order without touching a single provider document.
 *
 * `feeCentavos: 0` IS "free" — there is no separate flag to keep in sync with
 * an amount. `premiumWindowFeeCentavos` is what a paid scheduled window costs;
 * null inherits the base, because a provider who never priced the premium tier
 * has not agreed to charge more for it.
 */
@ObjectType()
@Schema({ _id: false })
export class LegPricingConfig {
  @Field(() => Int)
  @Prop({ type: Number, default: 0, min: 0 })
  feeCentavos!: number;

  /**
   * Defaults to the platform's historical ₱50 scheduled-window fee rather than
   * null, so a config auto-created by `getOrCreateConfig` prices exactly as the
   * old constants did. Setting it null afterwards means "same as the base fee".
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: 5000, min: 0 })
  premiumWindowFeeCentavos?: number | null;
}
export const LegPricingConfigSchema =
  SchemaFactory.createForClass(LegPricingConfig);

/**
 * Per-leg commercial terms. Provider-level rather than per-day: which days a
 * leg runs is a capability (DayFulfillment), what it costs is not.
 *
 * The customer-travelled legs are absent by design — drop-off and self-pickup
 * cost the provider nothing to fulfil, so they are hard zero in the pricing
 * util rather than a configurable value someone could accidentally set.
 */
/**
 * A paid promise about how fast the laundry is DONE — not how fast it travels.
 *
 * Express used to be a `DeliverySubMode`, which tied speed to the outbound leg
 * and had two consequences: a customer collecting their own laundry could never
 * buy speed, and "express" meant nothing operationally — it added ₱120 and set
 * no deadline anywhere in the system.
 *
 * The clock starts at PROVIDER_RECEIVED because that is the one moment common
 * to every inbound path (courier pickup, washer pickup, customer drop-off).
 * Starting it at booking would penalise a provider for a pickup window the
 * customer chose.
 */
@ObjectType()
@Schema({ _id: false })
export class TurnaroundTierConfig {
  /** Off by default — a provider opts in to promising a deadline. */
  @Field() @Prop({ default: false }) enabled!: boolean;

  @Field(() => Int)
  @Prop({ type: Number, default: 12000, min: 0 })
  feeCentavos!: number;

  /** Hours from provider-received to laundry-ready. */
  @Field(() => Int)
  @Prop({ type: Number, default: 4, min: 1 })
  slaHours!: number;
}
export const TurnaroundTierConfigSchema =
  SchemaFactory.createForClass(TurnaroundTierConfig);

@ObjectType()
@Schema({ _id: false })
export class FulfillmentPricing {
  @Field(() => LegPricingConfig)
  @Prop({ type: LegPricingConfigSchema, default: () => ({}) })
  providerPickup!: LegPricingConfig;

  @Field(() => LegPricingConfig)
  @Prop({ type: LegPricingConfigSchema, default: () => ({}) })
  providerDelivery!: LegPricingConfig;

  /** The optional Express turnaround tier. Standard is always available, free. */
  @Field(() => TurnaroundTierConfig)
  @Prop({ type: TurnaroundTierConfigSchema, default: () => ({}) })
  express!: TurnaroundTierConfig;
}
export const FulfillmentPricingSchema =
  SchemaFactory.createForClass(FulfillmentPricing);

@ObjectType()
@Schema({ collection: 'booking_availability_configs', timestamps: true })
export class BookingAvailabilityConfig {
  @Field(() => ID)
  _id!: string;

  /**
   * What this provider charges per leg. Absent on documents written before
   * per-provider pricing existed — the util's defaults then price them exactly
   * as the old platform-wide constants did, so nothing re-prices on deploy.
   */
  @Field(() => FulfillmentPricing)
  @Prop({ type: FulfillmentPricingSchema, default: () => ({}) })
  fulfillmentPricing!: FulfillmentPricing;

  @Field(() => ID)
  @Prop({ type: String, required: true, unique: true })
  branchId!: string;

  @Field(() => ProviderType)
  @Prop({ type: String, enum: ProviderType, required: true })
  providerType!: ProviderType;

  // §1 — the master switch. Off means no scheduled bookings at all, whatever
  // the weekly schedule says.
  @Field()
  @Prop({ default: true })
  acceptScheduledBookings!: boolean;

  // §13 — a temporary pause, deliberately separate from closing the business
  // or emptying the schedule. Existing bookings stand; new ones are refused.
  @Field()
  @Prop({ default: false })
  bookingsPaused!: boolean;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null, trim: true })
  pauseReason?: string | null;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  pausedAt?: Date | null;

  // §2/§3
  @Field(() => WeeklyBookingSchedule)
  @Prop({ type: WeeklyBookingScheduleSchema, default: () => ({}) })
  weekly!: WeeklyBookingSchedule;

  /**
   * The provider's OWN chosen capacity — a request, not an entitlement.
   *
   * What she actually gets is min(this, platform entitlement), computed at read
   * time from the booking policy + her milestone + any live campaign. Nothing
   * from the policy is copied here: a campaign that doubles capacity for a
   * million providers must remain one record, not a million writes.
   *
   * Null means "take whatever I'm entitled to" — the common case, and the
   * reason a new provider needs no configuration at all.
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  dailyBookingLimit?: number | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  updatedBy?: string | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BookingAvailabilityConfigSchema = SchemaFactory.createForClass(
  BookingAvailabilityConfig,
);
