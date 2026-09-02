import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsNumber,
  IsPositive,
  IsString,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';

@InputType()
export class DamageInventoryInput {
  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  quantity!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: 'reason must be at most 200 characters' })
  @Field()
  reason!: string;
}
