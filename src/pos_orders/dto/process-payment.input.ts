import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { PaymentMethod } from '../../pos_transactions/schemas/pos-transaction.schema';

@InputType()
export class ProcessPaymentInput {
  @IsEnum(PaymentMethod)
  @Field(() => PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Field({ nullable: true })
  referenceId?: string;

  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  amountPaid!: number;
}
