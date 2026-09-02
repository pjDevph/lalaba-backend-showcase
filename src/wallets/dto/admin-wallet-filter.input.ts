import { InputType, Field, Int, ID } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { TopUpIntentStatus } from '../schemas/topup-intent.schema';
import { WalletProviderType } from '../models/admin-wallet.model';

@InputType()
export class AdminWalletFilterInput {
  /** Matches the provider's shop name, case-insensitive substring. */
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  @IsOptional()
  @IsEnum(WalletProviderType)
  @Field(() => WalletProviderType, { nullable: true })
  providerType?: WalletProviderType;

  /**
   * Only wallets whose stored balance disagrees with their ledger.
   *
   * The reason this is a filter and not just a sort: on a healthy platform the
   * answer is an empty list, and "show me the broken ones" is the question an
   * admin opens this page to ask.
   */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  varianceOnly?: boolean;

  /** Only wallets below the ₱100 accept-a-booking minimum. */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  belowAcceptMinimum?: boolean;

  /** Only wallets that have never reached the ₱1,000 onboarding minimum. */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  notActivated?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Field(() => Int, { nullable: true, defaultValue: 25 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}

@InputType()
export class AdminTopUpFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  branchId?: string;

  @IsOptional()
  @IsEnum(TopUpIntentStatus)
  @Field(() => TopUpIntentStatus, { nullable: true })
  status?: TopUpIntentStatus;

  /**
   * Only intents the gateway said succeeded but which have no ledger credit —
   * i.e. money collected that never reached a wallet. Always empty on a
   * healthy platform, and the first thing to check when a provider says a
   * top-up vanished.
   */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  unreconciledOnly?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Field(() => Int, { nullable: true, defaultValue: 25 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}
