import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { Wallet } from './schemas/wallet.schema';
import { WalletLedgerEntry } from './schemas/wallet-ledger-entry.schema';
import { TopUpIntent } from './schemas/topup-intent.schema';
import { TopUpWalletInput } from './dto/top-up-wallet.input';
import { WalletReconciliationReport } from './models/wallet-reconciliation.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => Wallet)
@Roles('merchant', 'washer')
@UseGuards(GqlAuthGuard, RolesGuard)
export class WalletsResolver {
  constructor(private readonly walletsService: WalletsService) {}

  @Query(() => Wallet, { name: 'walletSummary' })
  async walletSummary(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ): Promise<Wallet> {
    await this.walletsService.assertOwnsBranch(branchId, user._id);
    return this.walletsService.getWallet(branchId);
  }

  @Query(() => [WalletLedgerEntry], { name: 'walletLedger' })
  async walletLedger(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ): Promise<WalletLedgerEntry[]> {
    await this.walletsService.assertOwnsBranch(branchId, user._id);
    return this.walletsService.ledger(branchId);
  }

  /**
   * Top-up attempts, newest first — PENDING and FAILED/EXPIRED included.
   *
   * `walletLedger` only reports settled money, so this is the only way the FE
   * can surface an in-flight attempt (user is mid-checkout, or closed the page
   * before paying) or a failed one. Returns `invoiceUrl` too, so a PENDING row
   * can offer to reopen its checkout page rather than starting a second
   * top-up alongside the first.
   */
  @Query(() => [TopUpIntent], { name: 'topUpHistory' })
  async topUpHistory(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ): Promise<TopUpIntent[]> {
    await this.walletsService.assertOwnsBranch(branchId, user._id);
    return this.walletsService.topUpHistory(branchId);
  }

  /**
   * Secure top-up lifecycle (RISK-P0-003): creates a PENDING intent + gateway
   * invoice and returns it — the wallet is credited only by the verified
   * webhook. FE opens `invoiceUrl` and polls `topUpStatus`.
   */
  @Mutation(() => TopUpIntent)
  async initializeTopUp(
    @Args('input') input: TopUpWalletInput,
    @CurrentUser() user: User,
  ): Promise<TopUpIntent> {
    return this.walletsService.initializeTopUp(
      input.branchId,
      input.amountCentavos,
      user._id,
    );
  }

  @Query(() => TopUpIntent, { name: 'topUpStatus' })
  async topUpStatus(
    @Args('intentId', { type: () => ID }) intentId: string,
    @CurrentUser() user: User,
  ): Promise<TopUpIntent> {
    return this.walletsService.topUpStatus(intentId, user._id);
  }

  /** Financial-integrity audit: every wallet balance recomputed from its
   * ledger; any non-zero variance is a red flag. Admin-only. */
  @Query(() => WalletReconciliationReport, {
    name: 'walletReconciliationReport',
  })
  @Roles('admin')
  async walletReconciliationReport(): Promise<WalletReconciliationReport> {
    return this.walletsService.reconciliationReport();
  }
}
