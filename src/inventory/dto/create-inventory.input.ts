import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';
import { InventoryUnit, InventoryCategory } from '../schemas/inventory.schema';

@InputType()
export class CreateInventoryInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  productName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  branchId!: string;

  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  cost!: number;

  @IsEnum(InventoryUnit)
  @Field(() => InventoryUnit)
  inventoryUnit!: InventoryUnit;

  @IsEnum(InventoryCategory)
  @Field(() => InventoryCategory)
  inventoryCategory!: InventoryCategory;

  @IsNumber()
  @Min(0)
  @Field(() => Float)
  stockQuantity!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  threshold?: number;
}
