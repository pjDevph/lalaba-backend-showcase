import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { TopUpIntent } from '../schemas/topup-intent.schema';
import { WalletLedgerEntry } from '../schemas/wallet-ledger-entry.schema';

/**
 * Which side of the platform a wallet belongs to. Deliberately its own enum
 * rather than reusing online-orders' ProviderType: the wallet module must not
 * depend on the order module's SDL just to label a row.
 */
export enum WalletProviderType {
  MERCHANT = 'MERCHANT',
  WASHER = 'WASHER',
}
registerEnumType(WalletProviderType, { name: 'WalletProviderType' });

/**
 * One provider's wallet as Admin sees it.
 *
 * This is NOT `Wallet` with extra fields. `Wallet` is the stored document; the
 * three numbers an admin actually acts on — is she activated, can she accept a
 * booking right now, do her books balance — are each derived from a different
 * source (the wallet doc, the constants, the ledger), and computing them at
 * three separate call sites is how they end up disagreeing.
 */
@ObjectType()
export class AdminWalletRow {
  @Field(() => ID)
  branchId!: string;

  @Field(() => WalletProviderType)
  providerType!: WalletProviderType;

  /** Shop name — `washerStoreName` for a washer, `branchName` for a merchant. */
  @Field()
  name!: string;

  /** Stored running total on the wallet document. */
  @Field(() => Int)
  balanceCentavos!: number;

  /** Recomputed from the append-only ledger. Should always equal the above. */
  @Field(() => Int)
  ledgerBalanceCentavos!: number;

  /**
   * balance − ledger. Anything other than 0 means a balance moved outside the
   * ledgered paths, which is the single most serious thing this page can show.
   */
  @Field(() => Int)
  varianceCentavos!: number;

  @Field(() => Int)
  ledgerEntryCount!: number;

  /**
   * Stamped the first time the balance reached the ₱1,000 onboarding minimum.
   * Once set it never clears — dropping below ₱1,000 later does NOT
   * de-activate her, it only stops her meeting the accept minimum below.
   */
  @Field(() => Date, { nullable: true })
  activatedAt?: Date | null;

  /**
   * Whether the balance currently clears the ₱100 accept-a-booking minimum.
   * Computed here so Admin reads the same answer discovery does, rather than
   * eyeballing the balance against a threshold they have to remember.
   */
  @Field()
  meetsAcceptMinimum!: boolean;

  /**
   * True when she is discoverable on balance grounds — activated AND above the
   * accept minimum. Other things (verification, booking policy) can still hide
   * her; this field speaks only for the wallet.
   */
  @Field()
  walletAllowsDiscovery!: boolean;

  /**
   * Top-up attempts still PENDING. A non-zero count is usually an abandoned
   * checkout rather than a problem, but a provider phoning in about money that
   * "did not arrive" is nearly always looking at one of these.
   */
  @Field(() => Int)
  pendingTopUpCount!: number;

  @Field(() => Date, { nullable: true })
  lastLedgerEntryAt?: Date | null;
}

@ObjectType()
export class AdminWalletPage {
  @Field(() => [AdminWalletRow])
  data!: AdminWalletRow[];

  @Field(() => Int)
  total!: number;

  /** Wallets with a non-zero variance across the WHOLE set, not just this page. */
  @Field(() => Int)
  varianceCount!: number;

  /** Sum of every wallet balance on the platform, across the whole set. */
  @Field(() => Int)
  totalBalanceCentavos!: number;
}

@ObjectType()
export class AdminWalletLedgerPage {
  @Field(() => [WalletLedgerEntry])
  data!: WalletLedgerEntry[];

  @Field(() => Int)
  total!: number;
}

/** A top-up attempt plus the provider it belongs to, for the platform-wide log. */
@ObjectType()
export class AdminTopUpRow {
  @Field(() => TopUpIntent)
  intent!: TopUpIntent;

  @Field()
  providerName!: string;

  @Field(() => WalletProviderType)
  providerType!: WalletProviderType;

  /**
   * Whether a ledger credit exists for this intent. A SUCCEEDED intent with no
   * ledger row means the webhook resolved the intent but the credit never
   * landed — money taken, wallet not funded. Nothing else in the product can
   * surface that.
   */
  @Field()
  hasLedgerCredit!: boolean;
}

@ObjectType()
export class AdminTopUpPage {
  @Field(() => [AdminTopUpRow])
  data!: AdminTopUpRow[];

  @Field(() => Int)
  total!: number;
}
