import { InputType, Field, Int, ID } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';
import { MAX_TOPUP_CENTAVOS } from '../wallet.constants';

/**
 * Secure top-up lifecycle (RISK-P0-003): the client only names the branch and
 * the amount. It can no longer supply a payment reference — references are
 * minted server-side (the TopUpIntent id) and settled only by the verified
 * gateway webhook.
 */
@InputType()
export class TopUpWalletInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  branchId!: string;

  // GAP-H-033: integer centavos only. Int in GraphQL rejects floats/NaN at
  // parse time; @IsInt guards the non-GraphQL paths too.
  @IsInt()
  @Min(1)
  @Max(MAX_TOPUP_CENTAVOS)
  @Field(() => Int)
  amountCentavos!: number;
}
