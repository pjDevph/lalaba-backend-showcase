import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

@InputType()
export class RestockInventoryInput {
  @IsNumber()
  @IsPositive()
  @Field(() => Float)
  quantity!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'reason must be at most 200 characters' })
  reason?: string;
}
