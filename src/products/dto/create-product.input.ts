import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
} from 'class-validator';
import { InventoryUnit } from '../../inventory/schemas/inventory.schema';
import { ProductCategory } from '../schemas/product.schema';

@InputType()
export class CreateProductInput {
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
  price!: number;

  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  quantity!: number;

  @IsEnum(InventoryUnit)
  @Field(() => InventoryUnit)
  productUnit!: InventoryUnit;

  @IsEnum(ProductCategory)
  @Field(() => ProductCategory)
  productCategory!: ProductCategory;
}
