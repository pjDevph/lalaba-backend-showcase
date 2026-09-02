import { InputType, Field, Float, ID, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsNumber, IsOptional, Min } from 'class-validator';
import {
  WasherPricingModel,
  WasherServiceUnit,
} from '../../washer-service-templates/schemas/washer-service-template.schema';

@InputType()
export class SetWasherServiceOfferingInput {
  @Field(() => ID)
  serviceTemplateId!: string;

  @Field(() => WasherPricingModel)
  @IsEnum(WasherPricingModel)
  pricingModel!: WasherPricingModel;

  /** Per kg, per load, or the base price — depends on `pricingModel`. */
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  priceCentavos!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  loadCapacityKg?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  baseWeightKg?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  excessRatePerKgCentavos?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minBillableKg?: number;

  // ── PER_ITEM ─────────────────────────────────────────────────────────────
  // Required in practice for PER_ITEM, but nullable here so a washer switching
  // models doesn't have to send fields her model ignores. The real requirement
  // lives in assertOfferingAllowed, where the message can name the model.

  @Field(() => WasherServiceUnit, { nullable: true })
  @IsOptional()
  @IsEnum(WasherServiceUnit)
  unit?: WasherServiceUnit;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  minQuantity?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxQuantity?: number;
}
