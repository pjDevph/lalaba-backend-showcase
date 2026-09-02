import { InputType, Field, Float } from '@nestjs/graphql';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  OrderItemType,
  DiscountType,
  FulfillmentType,
} from '../schemas/pos-order.schema';
import {
  DefaultProductPer,
  PricingType,
} from '../../services/schemas/service.schema';
import { InventoryUnit } from '../../inventory/schemas/inventory.schema';

@InputType()
class DefaultProductItemInput {
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

  @IsBoolean()
  @Field()
  included!: boolean;

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
export class OrderItemInput {
  @IsEnum(OrderItemType)
  @Field(() => OrderItemType)
  type!: OrderItemType;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  serviceId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  serviceName?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  serviceCode?: string;

  @IsOptional()
  @IsEnum(PricingType)
  @Field(() => PricingType, { nullable: true })
  pricingType?: PricingType;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DefaultProductItemInput)
  @Field(() => [DefaultProductItemInput], { nullable: true })
  defaultProducts?: DefaultProductItemInput[];

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  productId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  productName?: string;

  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  quantity!: number;

  // Required only for type: custom — the client-supplied price for an
  // ad-hoc line item (e.g. a delivery fee) that has no Service/Product record
  // to derive a price from.
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Field(() => Float, { nullable: true })
  unitPrice?: number;
}

@InputType()
export class CreateOrderInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  branchId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field({ nullable: true })
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Field({ nullable: true })
  customerPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Field({ nullable: true })
  customerAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Field({ nullable: true })
  notes?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Order must contain at least one item' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemInput)
  @Field(() => [OrderItemInput])
  items!: OrderItemInput[];

  @IsOptional()
  @IsEnum(DiscountType)
  @Field(() => DiscountType, { nullable: true })
  discountType?: DiscountType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  discountValue?: number;

  @IsOptional()
  @Field({ nullable: true })
  estimatedReadyAt?: Date;

  @IsOptional()
  @IsEnum(FulfillmentType)
  @Field(() => FulfillmentType, { nullable: true })
  fulfillmentType?: FulfillmentType;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  @Field({ nullable: true })
  idempotencyKey?: string;
}
