import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * THE PLATFORM BOOKING POLICY — one record, evaluated against every provider.
 *
 * The rule this whole module exists to enforce: changing a booking rule must
 * never write to provider documents. With a million providers, a "2× capacity
 * for Laundry Week" promo implemented as `for each provider: cap *= 2` is a
 * million writes, a million-row rollback, and a synchronisation problem the
 * moment one write fails halfway. So nothing here is ever copied onto a
 * provider. A provider stores only her own statistics and her own schedule;
 * her effective entitlement is COMPUTED from:
 *
 *   policy defaults  →  milestone unlocked  →  active campaigns  →  safety cap
 *
 * Versioning is why a published policy is a NEW document rather than an update
 * in place: the change history in the admin page is just the older rows, and a
 * bad publish is reverted by making a previous version live again — not by
 * reconstructing what the numbers used to be.
 *
 * CAPACITY IS HOME-WASHER ONLY (settled). A laundromat has staff and several
 * machines; a platform-imposed order cap does not describe it. Merchant
 * branches are still governed by the TIMING rules here — slot interval,
 * advance window, lead time, same-day cutoff, universal booking days — because
 * those shape the customer's booking experience, not the provider's throughput.
 */

export enum BookingPolicyStatus {
  LIVE = 'live',
  ARCHIVED = 'archived',
}
registerEnumType(BookingPolicyStatus, { name: 'BookingPolicyStatus' });

/** Platform fallbacks used when no policy has ever been published. */
export const POLICY_SEED = {
  // 3 bookings/day is the launch number for home washers — one person doing
  // laundry by hand, not a shop. It is admin-owned and deliberately not
  // provider-editable: the provider-facing capacity fields were removed, so a
  // washer types nothing here and simply inherits this. Raise it per-milestone
  // when incentives arrive, rather than by letting washers set their own.
  dailyCapacity: 3,
  advanceBookingDays: 14,
  leadTimeMinutes: 120,
  sameDayBookingEnabled: true,
  sameDayCutoffTime: '17:00',
  safety: {
    dailyCapacity: 100,
    advanceBookingDays: 60,
    maxLegFeeCentavos: 20000, // ₱200 per leg
    maxServiceRadiusKm: 15,
  },
  windowOpen: '06:00',
  windowClose: '22:00',
};

@ObjectType()
@Schema({ _id: false })
export class PolicyWindow {
  @Field() @Prop({ required: true }) start!: string; // 'HH:MM' PH-local
  @Field() @Prop({ required: true }) end!: string;
}
export const PolicyWindowSchema = SchemaFactory.createForClass(PolicyWindow);

/**
 * The OUTER bound for one weekday — the widest a provider is allowed to open,
 * not the hours she keeps. A provider picks her own window inside this one; a
 * request to open outside it is refused.
 */
@ObjectType()
@Schema({ _id: false })
export class UniversalDay {
  @Field() @Prop({ default: true }) isOpen!: boolean;

  @Field(() => [PolicyWindow])
  @Prop({ type: [PolicyWindowSchema], default: [] })
  windows!: PolicyWindow[];
}
export const UniversalDaySchema = SchemaFactory.createForClass(UniversalDay);

@ObjectType()
@Schema({ _id: false })
export class UniversalWeek {
  @Field(() => UniversalDay)
  @Prop({ type: UniversalDaySchema, default: () => ({}) })
  monday!: UniversalDay;
  @Field(() => UniversalDay)
  @Prop({ type: UniversalDaySchema, default: () => ({}) })
  tuesday!: UniversalDay;
  @Field(() => UniversalDay)
  @Prop({ type: UniversalDaySchema, default: () => ({}) })
  wednesday!: UniversalDay;
  @Field(() => UniversalDay)
  @Prop({ type: UniversalDaySchema, default: () => ({}) })
  thursday!: UniversalDay;
  @Field(() => UniversalDay)
  @Prop({ type: UniversalDaySchema, default: () => ({}) })
  friday!: UniversalDay;
  @Field(() => UniversalDay)
  @Prop({ type: UniversalDaySchema, default: () => ({}) })
  saturday!: UniversalDay;
  @Field(() => UniversalDay)
  @Prop({ type: UniversalDaySchema, default: () => ({}) })
  sunday!: UniversalDay;
}
export const UniversalWeekSchema = SchemaFactory.createForClass(UniversalWeek);

/** §1 — what every eligible provider gets before any milestone is unlocked. */
@ObjectType()
@Schema({ _id: false })
export class PolicyDefaults {
  // Home-washer only. A laundromat manages its own throughput.
  @Field(() => Int)
  @Prop({ type: Number, default: POLICY_SEED.dailyCapacity, min: 0 })
  dailyCapacity!: number;

  @Field(() => Int)
  @Prop({ type: Number, default: POLICY_SEED.advanceBookingDays, min: 0 })
  advanceBookingDays!: number;

  @Field(() => Int)
  @Prop({ type: Number, default: POLICY_SEED.leadTimeMinutes, min: 0 })
  leadTimeMinutes!: number;

  @Field()
  @Prop({ default: POLICY_SEED.sameDayBookingEnabled })
  sameDayBookingEnabled!: boolean;

  @Field()
  @Prop({ type: String, default: POLICY_SEED.sameDayCutoffTime })
  sameDayCutoffTime!: string;
}
export const PolicyDefaultsSchema =
  SchemaFactory.createForClass(PolicyDefaults);

/**
 * The absolute ceiling nothing can exceed — the backstop for multiplier
 * campaigns in particular. A 2× on top of a 70/day milestone computes 140; this
 * is what stops that reaching a real washer's queue.
 */
@ObjectType()
@Schema({ _id: false })
export class PolicySafetyLimits {
  @Field(() => Int)
  @Prop({ type: Number, default: POLICY_SEED.safety.dailyCapacity, min: 1 })
  dailyCapacity!: number;

  @Field(() => Int)
  @Prop({
    type: Number,
    default: POLICY_SEED.safety.advanceBookingDays,
    min: 1,
  })
  advanceBookingDays!: number;

  /**
   * The most a provider may charge for ONE fulfillment leg, in centavos.
   *
   * A ceiling, not a price: providers set their own pickup/delivery fees, and
   * this bounds them. Lives with the capacity ceilings because it answers the
   * same question — how far a provider's own configuration may go — and is
   * applied the same way, as `min(request, ceiling)` computed at order time
   * rather than written into provider documents.
   */
  @Field(() => Int)
  @Prop({
    type: Number,
    default: POLICY_SEED.safety.maxLegFeeCentavos,
    min: 0,
  })
  maxLegFeeCentavos!: number;

  /**
   * The farthest a home washer may set her own service radius, in km.
   *
   * Same shape as maxLegFeeCentavos: a provider-set value, admin-bounded.
   * Enforced server-side in WasherService.updateProfile as a hard rejection
   * (not a silent clamp) — a washer who types 50 should see why, not have her
   * input quietly rewritten to 15.
   */
  @Field(() => Float)
  @Prop({
    type: Number,
    default: POLICY_SEED.safety.maxServiceRadiusKm,
    min: 1,
  })
  maxServiceRadiusKm!: number;
}
export const PolicySafetyLimitsSchema =
  SchemaFactory.createForClass(PolicySafetyLimits);

export type BookingPolicyDocument = BookingPolicy & Document;

@ObjectType()
@Schema({ collection: 'booking_policies', timestamps: true })
export class BookingPolicy {
  @Field(() => ID)
  _id!: string;

  /** Monotonic. The admin page shows it as "Version 12". */
  @Field(() => Int)
  @Prop({ type: Number, required: true })
  version!: number;

  @Field(() => BookingPolicyStatus)
  @Prop({
    type: String,
    enum: BookingPolicyStatus,
    default: BookingPolicyStatus.LIVE,
  })
  status!: BookingPolicyStatus;

  /** Master switch — off means the platform takes no scheduled bookings. */
  @Field()
  @Prop({ default: true })
  enabled!: boolean;

  @Field(() => PolicyDefaults)
  @Prop({ type: PolicyDefaultsSchema, default: () => ({}) })
  defaults!: PolicyDefaults;

  @Field(() => UniversalWeek)
  @Prop({ type: UniversalWeekSchema, default: () => ({}) })
  universalDays!: UniversalWeek;

  @Field(() => PolicySafetyLimits)
  @Prop({ type: PolicySafetyLimitsSchema, default: () => ({}) })
  safetyLimits!: PolicySafetyLimits;

  /** Why this version was published — the change history reads it back. */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null, trim: true })
  changeNote?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  publishedBy?: string | null;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  publishedAt?: Date | null;

  @Field(() => Float, { nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BookingPolicySchema = SchemaFactory.createForClass(BookingPolicy);
BookingPolicySchema.index({ version: -1 });
// Exactly one LIVE row. A partial unique index makes that the database's
// invariant rather than a rule the service has to remember on every publish.
BookingPolicySchema.index(
  { status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: BookingPolicyStatus.LIVE },
  },
);
