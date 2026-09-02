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
import { PricingType, ServiceCategory } from '../schemas/service.schema';

@InputType()
export class ServiceFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  branchId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  @IsOptional()
  @IsEnum(ServiceCategory)
  @Field(() => ServiceCategory, { nullable: true })
  category?: ServiceCategory;

  @IsOptional()
  @IsEnum(PricingType)
  @Field(() => PricingType, { nullable: true })
  pricingType?: PricingType;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isArchived?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Field(() => Int, { nullable: true, defaultValue: 10 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}
