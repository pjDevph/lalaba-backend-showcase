import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

@InputType()
export class StaffFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  branchId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  roleId?: string;

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
  @Max(100)
  @Field(() => Int, { nullable: true, defaultValue: 10 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}
