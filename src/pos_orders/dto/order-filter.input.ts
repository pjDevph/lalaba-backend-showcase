import { InputType, Field, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LaundryStatus, PaymentStatus } from '../schemas/pos-order.schema';

@InputType()
export class OrderFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  branchId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  @IsOptional()
  @IsEnum(LaundryStatus)
  @Field(() => LaundryStatus, { nullable: true })
  laundryStatus?: LaundryStatus;

  @IsOptional()
  @IsEnum(PaymentStatus)
  @Field(() => PaymentStatus, { nullable: true })
  paymentStatus?: PaymentStatus;

  @IsOptional()
  @Field({ nullable: true })
  dateFrom?: Date;

  @IsOptional()
  @Field({ nullable: true })
  dateTo?: Date;

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
