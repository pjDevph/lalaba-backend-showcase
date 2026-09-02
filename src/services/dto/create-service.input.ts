import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  IsBoolean,
  IsOptional,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DefaultProductPer,
  PricingType,
  ServiceCategory,
} from '../schemas/service.schema';
import { InventoryUnit } from '../../inventory/schemas/inventory.schema';

@InputType()
class DefaultProductInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  inventoryId!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  productName!: string;

  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  quantity!: number;

  @IsOptional()
  @IsEnum(InventoryUnit)
  @Field(() => InventoryUnit, { nullable: true })
  unit?: InventoryUnit;

  @IsOptional()
  @IsEnum(DefaultProductPer)
  @Field(() => DefaultProductPer, { nullable: true })
  per?: DefaultProductPer;
}

@InputType()
export class CreateServiceInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  branchId!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  serviceName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^[A-Z0-9-]+$/, {
    message: 'serviceCode must be uppercase letters, numbers, or hyphens only',
  })
  @Field({ nullable: true })
  serviceCode?: string;

  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  price!: number;

  @IsEnum(PricingType)
  @Field(() => PricingType)
  pricingType!: PricingType;

  @ValidateIf((o) => o.pricingType === PricingType.PER_KILO_WITH_BASE)
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  baseKilos?: number;

  @ValidateIf((o) => o.pricingType === PricingType.PER_KILO_WITH_BASE)
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  excessRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  suppliesCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  estimatedMinutes?: number;

  @IsEnum(ServiceCategory)
  @Field(() => ServiceCategory)
  category!: ServiceCategory;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DefaultProductInput)
  @Field(() => [DefaultProductInput], { nullable: true })
  defaultProducts?: DefaultProductInput[];

  @IsBoolean()
  @Field()
  requiresWeighing!: boolean;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isOnline?: boolean;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isFeatured?: boolean;
}
