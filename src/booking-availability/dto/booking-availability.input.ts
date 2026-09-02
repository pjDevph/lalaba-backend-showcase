import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** 'HH:MM', 24-hour, PH-local. Rejected at the edge so no parse fails deeper in. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 'YYYY-MM-DD'. Calendar validity is checked in the service. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

@InputType()
export class BookingWindowInput {
  @Matches(HHMM, { message: 'start must be HH:MM' })
  @Field()
  start!: string;

  @Matches(HHMM, { message: 'end must be HH:MM' })
  @Field()
  end!: string;
}

@InputType()
export class DayFulfillmentInput {
  @IsBoolean() @Field() providerPickup!: boolean;
  @IsBoolean() @Field() providerDelivery!: boolean;
  @IsBoolean() @Field() customerDropoff!: boolean;
  @IsBoolean() @Field() customerPickup!: boolean;
}

@InputType()
export class DayBookingConfigInput {
  @IsBoolean() @Field() isAcceptingBookings!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookingWindowInput)
  @Field(() => [BookingWindowInput])
  windows!: BookingWindowInput[];

  // Null is meaningful: "inherit the config-level value". `nullable: true` on
  // the GraphQL field therefore has to accept an explicit null, not just an
  // omitted key — see the service's null-vs-undefined handling.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  dailyBookingLimit?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayFulfillmentInput)
  @Field(() => DayFulfillmentInput, { nullable: true })
  fulfillment?: DayFulfillmentInput;
}

@InputType()
export class WeeklyBookingScheduleInput {
  @ValidateNested()
  @Type(() => DayBookingConfigInput)
  @Field(() => DayBookingConfigInput)
  monday!: DayBookingConfigInput;
  @ValidateNested()
  @Type(() => DayBookingConfigInput)
  @Field(() => DayBookingConfigInput)
  tuesday!: DayBookingConfigInput;
  @ValidateNested()
  @Type(() => DayBookingConfigInput)
  @Field(() => DayBookingConfigInput)
  wednesday!: DayBookingConfigInput;
  @ValidateNested()
  @Type(() => DayBookingConfigInput)
  @Field(() => DayBookingConfigInput)
  thursday!: DayBookingConfigInput;
  @ValidateNested()
  @Type(() => DayBookingConfigInput)
  @Field(() => DayBookingConfigInput)
  friday!: DayBookingConfigInput;
  @ValidateNested()
  @Type(() => DayBookingConfigInput)
  @Field(() => DayBookingConfigInput)
  saturday!: DayBookingConfigInput;
  @ValidateNested()
  @Type(() => DayBookingConfigInput)
  @Field(() => DayBookingConfigInput)
  sunday!: DayBookingConfigInput;
}

/**
 * Admin's full config write (§1–§9). Every field optional so the page can save
 * only what changed; `weekly` is all-or-nothing because a partial week would
 * leave the other days ambiguous.
 */
@InputType()
export class UpdateBookingAvailabilityInput {
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  acceptScheduledBookings?: boolean;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  bookingsPaused?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field(() => String, { nullable: true })
  pauseReason?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => WeeklyBookingScheduleInput)
  @Field(() => WeeklyBookingScheduleInput, { nullable: true })
  weekly?: WeeklyBookingScheduleInput;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  dailyBookingLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  dailyBookingLimitCeiling?: number;

  // §7 — 0 means no minimum notice.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080) // one week; beyond that use advanceBookingDays instead
  @Field(() => Int, { nullable: true })
  leadTimeMinutes?: number;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  sameDayBookingEnabled?: boolean;

  @IsOptional()
  @Matches(HHMM, { message: 'sameDayCutoffTime must be HH:MM' })
  @Field({ nullable: true })
  sameDayCutoffTime?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  @Field(() => Int, { nullable: true })
  advanceBookingDays?: number;
}

/**
 * The provider-writable subset: the pause switch, and nothing else.
 *
 * Per-day capacity is a single platform number (BookingPolicy defaults), so
 * letting a provider type her own only ever moved her DOWN from it, with no
 * way back up once the field left the UI.
 *
 * What she still controls is the thing an overloaded washer genuinely needs
 * without a support ticket: stopping new bookings. Her schedule moved the other
 * way and became MORE hers — she now edits her own operating hours (see
 * WasherProfile.operatingHours), which is why this input did not simply
 * disappear along with the capacity fields.
 */
@InputType()
export class UpdateMyBookingCapacityInput {
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  bookingsPaused?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field(() => String, { nullable: true })
  pauseReason?: string | null;
}

/** One leg's fee request. Both amounts optional so a partial save is possible. */
@InputType()
export class LegPricingInput {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  feeCentavos?: number;

  /** Null explicitly means "same as the base fee". */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  premiumWindowFeeCentavos?: number | null;
}

/**
 * What a provider charges per fulfillment leg.
 *
 * Only a REQUEST — the effective fee is min(this, platform ceiling), resolved
 * at order time. A provider asking above the ceiling is not an error; they are
 * simply charged the ceiling, the same way an over-ambitious dailyBookingLimit
 * is clamped rather than rejected.
 */
/** The provider's Express turnaround offer. */
@InputType()
export class TurnaroundTierInput {
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  feeCentavos?: number;

  /** Hours from provider-received to laundry-ready. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  slaHours?: number;
}

@InputType()
export class UpdateFulfillmentPricingInput {
  @IsOptional()
  @ValidateNested()
  @Type(() => LegPricingInput)
  @Field(() => LegPricingInput, { nullable: true })
  providerPickup?: LegPricingInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => LegPricingInput)
  @Field(() => LegPricingInput, { nullable: true })
  providerDelivery?: LegPricingInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => TurnaroundTierInput)
  @Field(() => TurnaroundTierInput, { nullable: true })
  express?: TurnaroundTierInput;
}

/** §11 — upsert one date's override. */
@InputType()
export class UpsertBookingDateOverrideInput {
  @Matches(YMD, { message: 'date must be YYYY-MM-DD' })
  @Field()
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field(() => String, { nullable: true })
  label?: string | null;

  @IsBoolean() @Field() isClosed!: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookingWindowInput)
  @Field(() => [BookingWindowInput], { nullable: true })
  windows?: BookingWindowInput[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  dailyBookingLimit?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayFulfillmentInput)
  @Field(() => DayFulfillmentInput, { nullable: true })
  fulfillment?: DayFulfillmentInput | null;
}

/** §12 — block a date range. */
@InputType()
export class CreateBookingBlackoutInput {
  @Matches(YMD, { message: 'startDate must be YYYY-MM-DD' })
  @Field()
  startDate!: string;

  @Matches(YMD, { message: 'endDate must be YYYY-MM-DD' })
  @Field()
  endDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field(() => String, { nullable: true })
  reason?: string | null;
}

/** Copy one configured day onto others (§2's "Copy to other days"). */
@InputType()
export class CopyBookingDayInput {
  @IsString()
  @IsNotEmpty()
  @IsIn([
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ])
  @Field()
  fromDay!: string;

  @IsArray()
  @IsIn(
    [
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ],
    { each: true },
  )
  @Field(() => [String])
  toDays!: string[];
}

/** The scheduled window a customer picks at checkout. */
@InputType()
export class ScheduledPickupInput {
  @Matches(YMD, { message: 'date must be YYYY-MM-DD' })
  @Field()
  date!: string;
}

/** Identifies a provider for the admin-facing queries/mutations. */
@InputType()
export class ProviderRefInput {
  @IsString() @IsNotEmpty() @Field(() => ID) branchId!: string;
}
