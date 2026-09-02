import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

/** One wallet's ledger-vs-balance comparison (reconciliation groundwork). */
@ObjectType()
export class WalletReconciliationRow {
  @Field(() => ID)
  branchId!: string;

  /** Stored running balance on the wallet document. */
  @Field(() => Int)
  walletBalanceCentavos!: number;

  /** Balance recomputed as the sum of all ledger entry amounts. */
  @Field(() => Int)
  ledgerBalanceCentavos!: number;

  /** walletBalance − ledgerBalance. Expected: 0 for every wallet. */
  @Field(() => Int)
  varianceCentavos!: number;

  @Field(() => Int)
  ledgerEntryCount!: number;
}

@ObjectType()
export class WalletReconciliationReport {
  @Field()
  generatedAt!: Date;

  @Field(() => Int)
  walletsChecked!: number;

  @Field(() => Int)
  walletsWithVariance!: number;

  /** Only wallets whose variance ≠ 0 (empty list = clean books). */
  @Field(() => [WalletReconciliationRow])
  variances!: WalletReconciliationRow[];
}
