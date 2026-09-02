import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ProductCategory } from '../schemas/product.schema';

@InputType()
export class ProductFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  branchId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  @IsOptional()
  @IsEnum(ProductCategory)
  @Field(() => ProductCategory, { nullable: true })
  productCategory?: ProductCategory;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isArchived?: boolean;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Field(() => Int, { nullable: true, defaultValue: 10 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}
