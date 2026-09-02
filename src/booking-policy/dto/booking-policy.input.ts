import { InputType, Field, ID, Int, Float } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CampaignModifierMode,
  CampaignScope,
} from '../schemas/booking-campaign.schema';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

@InputType()
export class PolicyWindowInput {
  @Matches(HHMM, { message: 'start must be HH:MM' }) @Field() start!: string;
  @Matches(HHMM, { message: 'end must be HH:MM' }) @Field() end!: string;
}

@InputType()
export class UniversalDayInput {
  @IsBoolean() @Field() isOpen!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PolicyWindowInput)
  @Field(() => [PolicyWindowInput])
  windows!: PolicyWindowInput[];
}

@InputType()
export class UniversalWeekInput {
  @ValidateNested()
  @Type(() => UniversalDayInput)
  @Field(() => UniversalDayInput)
  monday!: UniversalDayInput;
  @ValidateNested()
  @Type(() => UniversalDayInput)
  @Field(() => UniversalDayInput)
  tuesday!: UniversalDayInput;
  @ValidateNested()
  @Type(() => UniversalDayInput)
  @Field(() => UniversalDayInput)
  wednesday!: UniversalDayInput;
  @ValidateNested()
  @Type(() => UniversalDayInput)
  @Field(() => UniversalDayInput)
  thursday!: UniversalDayInput;
  @ValidateNested()
  @Type(() => UniversalDayInput)
  @Field(() => UniversalDayInput)
  friday!: UniversalDayInput;
  @ValidateNested()
  @Type(() => UniversalDayInput)
  @Field(() => UniversalDayInput)
  saturday!: UniversalDayInput;
  @ValidateNested()
  @Type(() => UniversalDayInput)
  @Field(() => UniversalDayInput)
  sunday!: UniversalDayInput;
}

@InputType()
export class PolicyDefaultsInput {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  dailyCapacity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  @Field(() => Int, { nullable: true })
  advanceBookingDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080)
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
}

@InputType()
export class PolicySafetyLimitsInput {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  dailyCapacity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  @Field(() => Int, { nullable: true })
  advanceBookingDays?: number;

  /** Ceiling for a single provider-set fulfillment leg fee, in centavos. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  maxLegFeeCentavos?: number;

  /** Farthest a home washer may set her own service radius, in km. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  @Field(() => Float, { nullable: true })
  maxServiceRadiusKm?: number;
}

/**
 * One publish = one new policy version. Every section is optional so the admin
 * page can publish just the block that changed, and the service merges against
 * the live version before validating.
 */
@InputType()
export class PublishBookingPolicyInput {
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  enabled?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => PolicyDefaultsInput)
  @Field(() => PolicyDefaultsInput, { nullable: true })
  defaults?: PolicyDefaultsInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => UniversalWeekInput)
  @Field(() => UniversalWeekInput, { nullable: true })
  universalDays?: UniversalWeekInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => PolicySafetyLimitsInput)
  @Field(() => PolicySafetyLimitsInput, { nullable: true })
  safetyLimits?: PolicySafetyLimitsInput;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Field({ nullable: true })
  changeNote?: string;
}

// ── Milestones ─────────────────────────────────────────────────────────────

@InputType()
export class MilestoneEligibilityInput {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  minCompletedOrders?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  @Field(() => Float, { nullable: true })
  minRating?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Field(() => Float, { nullable: true })
  maxCancellationRatePercent?: number | null;

  @IsBoolean() @Field() requireVerified!: boolean;
  @IsBoolean() @Field() requireGoodStanding!: boolean;
}

@InputType()
export class MilestoneEntitlementsInput {
  @IsInt() @Min(0) @Field(() => Int) dailyCapacity!: number;
  @IsInt() @Min(0) @Max(365) @Field(() => Int) advanceBookingDays!: number;
  @IsBoolean() @Field() priorityBooking!: boolean;
}

@InputType()
export class UpsertBookingMilestoneInput {
  /** Stable slug — campaigns target it, so it is the upsert key, not the name. */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'key must be lowercase letters, numbers and dashes',
  })
  @Field()
  key!: string;

  @IsString() @IsNotEmpty() @MaxLength(60) @Field() name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field(() => String, { nullable: true })
  description?: string | null;

  @IsInt() @Min(0) @Field(() => Int) rank!: number;
  @IsBoolean() @Field() isDefault!: boolean;
  @IsBoolean() @Field() isActive!: boolean;

  @ValidateNested()
  @Type(() => MilestoneEligibilityInput)
  @Field(() => MilestoneEligibilityInput)
  eligibility!: MilestoneEligibilityInput;

  @ValidateNested()
  @Type(() => MilestoneEntitlementsInput)
  @Field(() => MilestoneEntitlementsInput)
  entitlements!: MilestoneEntitlementsInput;
}

// ── Campaigns ──────────────────────────────────────────────────────────────

@InputType()
export class CampaignModifierInput {
  @IsEnum(CampaignModifierMode)
  @Field(() => CampaignModifierMode)
  mode!: CampaignModifierMode;

  @IsNumber() @Min(0) @Field(() => Float) value!: number;
}

@InputType()
export class CampaignTargetingInput {
  @IsEnum(CampaignScope) @Field(() => CampaignScope) scope!: CampaignScope;

  @IsOptional()
  @IsEnum(ProviderType)
  @Field(() => ProviderType, { nullable: true })
  providerType?: ProviderType | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  milestoneKeys?: string[];
}

@InputType()
export class UpsertBookingCampaignInput {
  /** Omitted to create. */
  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  id?: string;

  @IsString() @IsNotEmpty() @MaxLength(80) @Field() name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Field(() => String, { nullable: true })
  description?: string | null;

  @Matches(YMD, { message: 'startDate must be YYYY-MM-DD' })
  @Field()
  startDate!: string;

  @Matches(YMD, { message: 'endDate must be YYYY-MM-DD' })
  @Field()
  endDate!: string;

  @IsBoolean() @Field() isEnabled!: boolean;

  @ValidateNested()
  @Type(() => CampaignTargetingInput)
  @Field(() => CampaignTargetingInput)
  targeting!: CampaignTargetingInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignModifierInput)
  @Field(() => CampaignModifierInput, { nullable: true })
  dailyCapacity?: CampaignModifierInput | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignModifierInput)
  @Field(() => CampaignModifierInput, { nullable: true })
  advanceBookingDays?: CampaignModifierInput | null;
}

@InputType()
export class SimulatePolicyInput {
  @IsEnum(ProviderType) @Field(() => ProviderType) providerType!: ProviderType;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  milestoneKey?: string | null;

  @IsOptional()
  @Matches(YMD, { message: 'date must be YYYY-MM-DD' })
  @Field({ nullable: true })
  date?: string;
}
