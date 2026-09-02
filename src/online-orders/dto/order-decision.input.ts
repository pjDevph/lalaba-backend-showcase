import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';

@InputType()
export class RejectOrderInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  @MaxLength(TEXT_LIMITS.SHORT)
  reason!: string;
}

@InputType()
export class ProposeOrderChangeInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  reason!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  revisedEstimatedTotalCentavos?: number;
}

@InputType()
export class CancelOrderInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  reason!: string;
}
