import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Wallet, WalletDocument } from './schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntryDocument,
} from './schemas/wallet-ledger-entry.schema';
import {
  TopUpIntent,
  TopUpIntentDocument,
  TopUpIntentStatus,
} from './schemas/topup-intent.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { washerStoreName } from '../washer/washer-name.util';
import {
  ACTIVATION_MIN_CENTAVOS,
  DISCOVERY_ACCEPT_MIN_CENTAVOS,
} from './wallet.constants';
import {
  AdminTopUpPage,
  AdminWalletLedgerPage,
  AdminWalletPage,
  AdminWalletRow,
  WalletProviderType,
} from './models/admin-wallet.model';
import {
  AdminTopUpFilterInput,
  AdminWalletFilterInput,
} from './dto/admin-wallet-filter.input';

/**
 * Admin's read-only view over every provider wallet.
 *
 * Separate from WalletsService for the same reason WasherAdminResolver is
 * separate from WasherResolver: every method on WalletsService is scoped to
 * one branch the CALLER owns (`assertOwnsBranch`), and nothing here is. Mixing
 * the two in one class means one forgotten ownership check away from a
 * provider reading another provider's books.
 *
 * Read-only: the wallet is prepaid and consumable, with no withdrawal path by
 * design (§17), and every balance change other than a manual correction comes
 * from a ledgered path — a verified gateway webhook, a fee consumption, or a
 * fee reversal. The one exception, `adjustWalletBalance`, lives on
 * WalletsAdminResolver (which also owns WalletsService) rather than here,
 * since every method on THIS service is read-only by construction.
 */
@Injectable()
export class WalletsAdminService {
  constructor(
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(WalletLedgerEntry.name)
    private readonly ledgerModel: Model<WalletLedgerEntryDocument>,
    @InjectModel(TopUpIntent.name)
    private readonly topUpIntentModel: Model<TopUpIntentDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
  ) {}

  /**
   * Every provider's name and type, keyed by branchId.
   *
   * A washer's wallet hangs off her anchor branch, so both provider kinds are
   * addressed by a branchId — but a washer must be named by `storeName`, not
   * by the anchor's `branchName`, to match how she is named in discovery,
   * chat and the order snapshot. Washers are resolved first and merchant
   * branches exclude those ids, exactly as BookingAvailabilityService does.
   */
  private async providerIndex(): Promise<
    Map<string, { name: string; providerType: WalletProviderType }>
  > {
    const [washers, branches] = await Promise.all([
      this.washerModel.find().select('branchId displayName storeName').exec(),
      this.branchModel.find().select('branchName').exec(),
    ]);

    const index = new Map<
      string,
      { name: string; providerType: WalletProviderType }
    >();
    for (const washer of washers) {
      index.set(washer.branchId, {
        name: washerStoreName(washer),
        providerType: WalletProviderType.WASHER,
      });
    }
    for (const branch of branches) {
      const branchId = String(branch._id);
      if (index.has(branchId)) continue;
      index.set(branchId, {
        name: branch.branchName,
        providerType: WalletProviderType.MERCHANT,
      });
    }
    return index;
  }

  /**
   * Every wallet, each reconciled against its own ledger.
   *
   * Filtering and paging happen in memory rather than in Mongo, because the
   * three things worth filtering on — variance, accept-minimum, provider name —
   * are none of them fields on the wallet document. Acceptable at this scale:
   * there is one wallet per provider, so this collection is bounded by how many
   * providers Lalaba has, not by traffic. Revisit if that stops being true.
   */
  async listWallets(
    filter: AdminWalletFilterInput = {},
  ): Promise<AdminWalletPage> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const [wallets, ledgerSums, pendingCounts, providers] = await Promise.all([
      this.walletModel.find().exec(),
      this.ledgerModel
        .aggregate<{
          _id: string;
          total: number;
          count: number;
          lastAt: Date | null;
        }>([
          {
            $group: {
              _id: '$branchId',
              total: { $sum: '$amountCentavos' },
              count: { $sum: 1 },
              lastAt: { $max: '$createdAt' },
            },
          },
        ])
        .exec(),
      this.topUpIntentModel
        .aggregate<{ _id: string; count: number }>([
          { $match: { status: TopUpIntentStatus.PENDING } },
          { $group: { _id: '$branchId', count: { $sum: 1 } } },
        ])
        .exec(),
      this.providerIndex(),
    ]);

    const sums = new Map(ledgerSums.map((s) => [s._id, s]));
    const pending = new Map(pendingCounts.map((p) => [p._id, p.count]));

    const rows: AdminWalletRow[] = wallets.map((wallet) => {
      const sum = sums.get(wallet.branchId);
      const ledgerBalance = sum?.total ?? 0;
      const provider = providers.get(wallet.branchId);
      const meetsAcceptMinimum =
        wallet.balanceCentavos >= DISCOVERY_ACCEPT_MIN_CENTAVOS;

      return {
        branchId: wallet.branchId,
        // A wallet whose branch has vanished still has to render — an orphan
        // is itself a finding, and dropping the row would hide it.
        providerType: provider?.providerType ?? WalletProviderType.MERCHANT,
        name: provider?.name ?? `Unknown provider (${wallet.branchId})`,
        balanceCentavos: wallet.balanceCentavos,
        ledgerBalanceCentavos: ledgerBalance,
        varianceCentavos: wallet.balanceCentavos - ledgerBalance,
        ledgerEntryCount: sum?.count ?? 0,
        activatedAt: wallet.activatedAt ?? null,
        meetsAcceptMinimum,
        walletAllowsDiscovery: wallet.activatedAt != null && meetsAcceptMinimum,
        pendingTopUpCount: pending.get(wallet.branchId) ?? 0,
        lastLedgerEntryAt: sum?.lastAt ?? null,
      };
    });

    // Platform totals are computed over EVERY wallet, before filtering and
    // paging — a variance count that changed when you typed in the search box
    // would be worse than useless.
    const varianceCount = rows.filter((r) => r.varianceCentavos !== 0).length;
    const totalBalanceCentavos = rows.reduce(
      (sum, r) => sum + r.balanceCentavos,
      0,
    );

    const search = filter.search?.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (search && !row.name.toLowerCase().includes(search)) return false;
      if (filter.providerType && row.providerType !== filter.providerType) {
        return false;
      }
      if (filter.varianceOnly && row.varianceCentavos === 0) return false;
      if (filter.belowAcceptMinimum && row.meetsAcceptMinimum) return false;
      if (filter.notActivated && row.activatedAt != null) return false;
      return true;
    });

    // Largest variance first, then lowest balance: both orderings put the rows
    // that need a human at the top, which is the only reason to open this page.
    filtered.sort((a, b) => {
      const varianceDelta =
        Math.abs(b.varianceCentavos) - Math.abs(a.varianceCentavos);
      if (varianceDelta !== 0) return varianceDelta;
      return a.balanceCentavos - b.balanceCentavos;
    });

    return {
      data: filtered.slice(offset, offset + limit),
      total: filtered.length,
      varianceCount,
      totalBalanceCentavos,
    };
  }

  /** One wallet's append-only ledger, newest first. */
  async ledgerPage(
    branchId: string,
    limit = 50,
    offset = 0,
  ): Promise<AdminWalletLedgerPage> {
    const [data, total] = await Promise.all([
      this.ledgerModel
        .find({ branchId })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.ledgerModel.countDocuments({ branchId }).exec(),
    ]);
    return { data, total };
  }

  /**
   * Platform-wide top-up log, newest first — every attempt, not only the ones
   * that became money.
   *
   * `hasLedgerCredit` is resolved by looking for a ledger row whose
   * `xenditReference` is the intent's own `_id` (the intent id doubles as the
   * gateway external_id and the ledger idempotency key). A SUCCEEDED intent
   * without one means the gateway took money that never reached a wallet.
   */
  async listTopUps(
    filter: AdminTopUpFilterInput = {},
  ): Promise<AdminTopUpPage> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const query: Record<string, unknown> = {};
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.status) query.status = filter.status;
    // An unreconciled intent can only be one the gateway settled, so narrow to
    // SUCCEEDED up front rather than paging through PENDING rows that can
    // never qualify.
    if (filter.unreconciledOnly) query.status = TopUpIntentStatus.SUCCEEDED;

    // Reconciliation is a property of the whole filtered set, not of one page:
    // paging first and then dropping reconciled rows would return short pages
    // and a total that lies. So resolve credits across the match, then page.
    const matched = await this.topUpIntentModel
      .find(query)
      .sort({ createdAt: -1 })
      .exec();

    const credited = new Set(
      (
        await this.ledgerModel
          .find({ xenditReference: { $in: matched.map((i) => String(i._id)) } })
          .select('xenditReference')
          .exec()
      ).map((entry) => entry.xenditReference),
    );

    const providers = await this.providerIndex();
    const rows = matched
      .map((intent) => {
        const provider = providers.get(intent.branchId);
        return {
          intent,
          providerName:
            provider?.name ?? `Unknown provider (${intent.branchId})`,
          providerType: provider?.providerType ?? WalletProviderType.MERCHANT,
          hasLedgerCredit: credited.has(String(intent._id)),
        };
      })
      .filter((row) => !filter.unreconciledOnly || !row.hasLedgerCredit);

    return {
      data: rows.slice(offset, offset + limit),
      total: rows.length,
    };
  }

  /** The two peso thresholds the panel displays, read from the one place they live. */
  thresholds(): { activationMinCentavos: number; acceptMinCentavos: number } {
    return {
      activationMinCentavos: ACTIVATION_MIN_CENTAVOS,
      acceptMinCentavos: DISCOVERY_ACCEPT_MIN_CENTAVOS,
    };
  }
}
