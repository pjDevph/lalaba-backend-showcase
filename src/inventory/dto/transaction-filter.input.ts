import { InputType, Field, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TransactionType } from '../schemas/inventory-transaction.schema';

@InputType()
export class TransactionFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  inventoryId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  branchId?: string;

  @IsOptional()
  @IsEnum(TransactionType)
  @Field(() => TransactionType, { nullable: true })
  type?: TransactionType;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  createdBy?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  createdByType?: string;

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
