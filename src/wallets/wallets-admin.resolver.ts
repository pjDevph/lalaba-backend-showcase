import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  ObjectType,
  Field,
} from '@nestjs/graphql';
import { BadRequestException, UseGuards } from '@nestjs/common';

import { WalletsAdminService } from './wallets-admin.service';
import { WalletsService } from './wallets.service';
import { Wallet } from './schemas/wallet.schema';
import {
  AdminTopUpPage,
  AdminWalletLedgerPage,
  AdminWalletPage,
} from './models/admin-wallet.model';
import {
  AdminTopUpFilterInput,
  AdminWalletFilterInput,
} from './dto/admin-wallet-filter.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';

/** The peso thresholds the wallet rules are evaluated against. */
@ObjectType()
export class WalletThresholds {
  /** ₱1,000 — first time the balance reaches this, the wallet is activated. */
  @Field(() => Int)
  activationMinCentavos!: number;

  /** ₱100 — below this she is not surfaced in discovery. */
  @Field(() => Int)
  acceptMinCentavos!: number;
}

/**
 * Admin-only wallet oversight. Its own resolver rather than more methods on
 * WalletsResolver, which is class-level `@Roles('merchant', 'washer')` and
 * whose every query is scoped to a branch the caller owns.
 *
 * Mostly queries. `adjustWalletBalance` is the one mutation, and deliberately
 * a late, narrow addition: the wallet is prepaid with no withdrawal path
 * (§17), and every OTHER credit or debit comes from a ledgered path — a
 * verified gateway webhook, a fee consumption, or a fee reversal. This
 * mutation is the exception, reserved for correcting a platform-side mistake
 * the other paths don't model — still fully ledgered (WalletsService.
 * adminAdjustBalance writes the same $inc-then-append-row shape every other
 * path does, so `walletReconciliationReport` never flags it as drift), and
 * every call is written to the admin-audit trail with a mandatory reason.
 */
@Resolver()
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class WalletsAdminResolver {
  constructor(
    private readonly walletsAdminService: WalletsAdminService,
    private readonly walletsService: WalletsService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Query(() => AdminWalletPage, { name: 'adminWallets' })
  async adminWallets(
    @Args('filter', { nullable: true }) filter?: AdminWalletFilterInput,
  ): Promise<AdminWalletPage> {
    return this.walletsAdminService.listWallets(filter ?? {});
  }

  @Query(() => AdminWalletLedgerPage, { name: 'adminWalletLedger' })
  async adminWalletLedger(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number,
  ): Promise<AdminWalletLedgerPage> {
    return this.walletsAdminService.ledgerPage(branchId, limit, offset);
  }

  @Query(() => AdminTopUpPage, { name: 'adminTopUps' })
  async adminTopUps(
    @Args('filter', { nullable: true }) filter?: AdminTopUpFilterInput,
  ): Promise<AdminTopUpPage> {
    return this.walletsAdminService.listTopUps(filter ?? {});
  }

  /**
   * Exposed so the panel prints the real numbers instead of hardcoding
   * "₱1,000" next to a rule that lives in wallet.constants.ts — the amounts
   * are still pending DECISION_REQUIRED-002 and will change.
   */
  @Query(() => WalletThresholds, { name: 'walletThresholds' })
  walletThresholds(): WalletThresholds {
    return this.walletsAdminService.thresholds();
  }

  /**
   * `deltaCentavos` is signed: positive credits, negative debits. `reason` is
   * REQUIRED, same as suspendWasher — this moves money, so there is no
   * unattributed version of this action.
   */
  @Mutation(() => Wallet, { name: 'adjustWalletBalance' })
  async adjustWalletBalance(
    @CurrentUser() actor: User,
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('deltaCentavos', { type: () => Int }) deltaCentavos: number,
    @Args('reason') reason: string,
  ): Promise<Wallet> {
    if (!reason.trim()) {
      throw new BadRequestException(
        'A reason is required to adjust a wallet balance',
      );
    }
    const updated = await this.walletsService.adminAdjustBalance(
      branchId,
      deltaCentavos,
    );
    await this.adminAudit.record({
      action: AdminAuditAction.WALLET_ADJUSTED,
      actor,
      targetType: AdminAuditTargetType.WALLET,
      targetId: branchId,
      reasonCode: reason,
      details: {
        deltaCentavos,
        balanceAfterCentavos: updated.balanceCentavos,
      },
    });
    return updated;
  }
}
