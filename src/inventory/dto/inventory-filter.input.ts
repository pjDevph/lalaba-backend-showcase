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
import { InventoryCategory } from '../schemas/inventory.schema';

@InputType()
export class InventoryFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  branchId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  @IsOptional()
  @IsEnum(InventoryCategory)
  @Field(() => InventoryCategory, { nullable: true })
  inventoryCategory?: InventoryCategory;

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
