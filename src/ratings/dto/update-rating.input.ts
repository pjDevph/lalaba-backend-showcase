import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';

@InputType()
export class UpdateRatingInput {
  @IsInt() @Min(1) @Max(5) @Field(() => Int) quality!: number;
  @IsInt() @Min(1) @Max(5) @Field(() => Int) speed!: number;
  @IsInt() @Min(1) @Max(5) @Field(() => Int) valueForMoney!: number;
  @IsInt() @Min(1) @Max(5) @Field(() => Int) delivery!: number;
  @IsInt() @Min(1) @Max(5) @Field(() => Int) communication!: number;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.SHORT)
  comment?: string;
}
