import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsEnum,
  IsArray,
  ArrayNotEmpty,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';
import {
  ALL_PRICING_MODELS,
  WasherPricingControl,
  WasherPricingModel,
  WasherServiceUnit,
} from '../schemas/washer-service-template.schema';

@InputType()
export class CreateWasherServiceTemplateInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  name!: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  description?: string;

  @IsNumber()
  @Min(0)
  @Field(() => Float)
  basePriceCentavos!: number;

  @IsNumber()
  @Min(0)
  @Field(() => Float)
  baseWeightKg!: number;

  @IsNumber()
  @Min(0)
  @Field(() => Float)
  excessRatePerKgCentavos!: number;

  // ── Pricing policy ───────────────────────────────────────────────────────
  // Omitted by older clients, so both default: washers set their own price and
  // may use any charging method. The three price fields above stay required —
  // under WASHER_SET they are the fallback a washer is priced at until she
  // sets her own, which is what keeps existing washers unaffected.

  @IsOptional()
  @IsEnum(WasherPricingControl)
  @Field(() => WasherPricingControl, {
    nullable: true,
    defaultValue: WasherPricingControl.WASHER_SET,
  })
  pricingControl?: WasherPricingControl;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Allow at least one charging method.' })
  @IsEnum(WasherPricingModel, { each: true })
  @Field(() => [WasherPricingModel], {
    nullable: true,
    defaultValue: ALL_PRICING_MODELS,
  })
  allowedPricingModels?: WasherPricingModel[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  minPriceCentavos?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  maxPriceCentavos?: number;

  // ── Platform pricing ─────────────────────────────────────────────────────
  // How Lalaba's own numbers are charged under PLATFORM_FIXED. Omitted by
  // older clients, defaulting to BASE_EXCESS — which is what a platform-priced
  // template did before it could be anything else.

  @IsOptional()
  @IsEnum(WasherPricingModel)
  @Field(() => WasherPricingModel, {
    nullable: true,
    defaultValue: WasherPricingModel.BASE_EXCESS,
  })
  platformPricingModel?: WasherPricingModel;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  platformLoadCapacityKg?: number | null;

  @IsOptional()
  @IsEnum(WasherServiceUnit)
  @Field(() => WasherServiceUnit, { nullable: true })
  platformUnit?: WasherServiceUnit | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  platformMinBillableKg?: number | null;

  // §10 — turnaround in hours, feeding the customer's "Estimated ready" line.
  // Null leaves the platform making no promise.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(720) // 30 days; anything longer is a data-entry slip, not a service
  @Field(() => Float, { nullable: true })
  turnaroundHours?: number | null;
}
