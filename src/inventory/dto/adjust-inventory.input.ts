import { InputType, Field, Float } from '@nestjs/graphql';
import { IsNumber, IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType()
export class AdjustInventoryInput {
  @IsNumber()
  @Field(() => Float)
  quantityChange!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: 'reason must be at most 200 characters' })
  @Field()
  reason!: string;
}
