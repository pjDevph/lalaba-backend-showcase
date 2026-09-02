import { InputType, Field, Float } from '@nestjs/graphql';
import { IsNumber, Max, Min } from 'class-validator';

@InputType()
export class SetPlatformFeeInput {
  @IsNumber()
  @Min(0)
  @Max(100)
  @Field(() => Float)
  feePercent!: number;
}
