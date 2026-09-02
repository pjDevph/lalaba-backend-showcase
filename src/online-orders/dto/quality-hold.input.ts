import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';

@InputType()
export class RaiseQualityHoldInput {
  // The validators are load-bearing, not decoration: the global ValidationPipe
  // runs with whitelist: true, which STRIPS any property carrying no
  // class-validator decorator. Without them this field never reached the
  // service, every hold stored an undefined serviceLineIndex, and reading such
  // an order then failed on the non-nullable QualityHold.serviceLineIndex —
  // taking the customer's whole order list down with it, not just that order.
  @IsInt()
  @Min(0)
  @Field(() => Int)
  serviceLineIndex!: number;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  category?: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  @MaxLength(TEXT_LIMITS.SHORT)
  reason!: string;

  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  photoUrls?: string[];

  // false = documentary only, never blocks — provider resolves it
  // unilaterally in the same call (see WasherServiceProductsService... no,
  // OnlineOrdersService.raiseQualityHold) and the order keeps processing.
  @IsBoolean()
  @Field()
  blocksOrder!: boolean;

  // SEC-007 — integer centavos, and fee-bearing: an approved surcharge is
  // charged the same snapshotted platform-fee rate as the base service, so a
  // provider cannot shift margin here to dodge the fee.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  additionalChargeCentavos?: number;
}

@InputType()
export class RespondToQualityHoldInput {
  @IsBoolean()
  @Field()
  approve!: boolean; // true = pay the additional charge and proceed with the fix; false = proceed without it
}
