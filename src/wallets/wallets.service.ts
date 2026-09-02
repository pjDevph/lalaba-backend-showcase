import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, isValidObjectId, Model } from 'mongoose';
import { Wallet, WalletDocument } from './schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntryDocument,
  WalletLedgerEntryType,
} from './schemas/wallet-ledger-entry.schema';
import {
  TopUpIntent,
  TopUpIntentDocument,
  TopUpIntentStatus,
} from './schemas/topup-intent.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { PaymentGatewayService } from './gateway/payment-gateway.service';
import {
  ACTIVATION_MIN_CENTAVOS,
  MAX_TOPUP_CENTAVOS,
  TOP_UP_HISTORY_LIMIT,
} from './wallet.constants';
import {
  WalletReconciliationReport,
  WalletReconciliationRow,
} from './models/wallet-reconciliation.model';

/** Normalized, gateway-verified payment event fed into postVerifiedTopUp. */
export interface VerifiedTopUpEvent {
  /** external_id / reference — must equal the TopUpIntent _id. */
  reference: string;
  amountCentavos: number;
  currency: string;
  gatewayInvoiceId?: string | null;
}

export interface PostTopUpResult {
  alreadyPosted: boolean;
  intent: TopUpIntent;
}

const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | undefined;
  return e?.code === DUPLICATE_KEY || /E11000/.test(e?.message ?? '');
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(WalletLedgerEntry.name)
    private readonly ledgerModel: Model<WalletLedgerEntryDocument>,
    @InjectModel(TopUpIntent.name)
    private readonly topUpIntentModel: Model<TopUpIntentDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    private readonly paymentGateway: PaymentGatewayService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Created at registration (washer's anchor branch) or branch creation
   * (merchant) — starts empty, per §17. Idempotent upsert on the unique
   * branchId (GAP-M-021): a retried registration/branch-create, or a lazy
   * recovery call, can never produce a duplicate or fail on an existing
   * wallet.
   */
  async createWallet(
    branchId: string,
    session?: ClientSession,
  ): Promise<Wallet> {
    const wallet = await this.walletModel
      .findOneAndUpdate(
        { branchId },
        { $setOnInsert: { branchId, balanceCentavos: 0 } },
        { new: true, upsert: true, session },
      )
      .exec();
    return wallet;
  }

  async getWallet(branchId: string): Promise<Wallet> {
    const wallet = await this.walletModel.findOne({ branchId }).exec();
    if (!wallet)
      throw new NotFoundException('Wallet not found for this branch');
    return wallet;
  }

  async ledger(branchId: string): Promise<WalletLedgerEntry[]> {
    return this.ledgerModel.find({ branchId }).sort({ createdAt: -1 }).exec();
  }

  /**
   * Top-up attempts for a branch, newest first — including the ones that never
   * became money.
   *
   * Deliberately NOT the same list as `ledger()`. The ledger gains a row only
   * when `postVerifiedTopUp` credits the wallet, so an intent the user
   * abandoned on the gateway's checkout page (PENDING), or that the gateway
   * reported FAILED/EXPIRED, appears nowhere in it. On the dev auto-succeed
   * gateway that gap is invisible — every intent settles inside the mutation —
   * but against real Xendit an abandoned checkout is the common case, and
   * without this query the FE has no way to show it happened at all.
   *
   * Callers that want a single unified activity list should merge this with
   * `ledger()` and drop intents whose `_id` already appears as a ledger row's
   * `xenditReference`, which is where a SUCCEEDED intent shows up.
   */
  async topUpHistory(branchId: string): Promise<TopUpIntent[]> {
    return this.topUpIntentModel
      .find({ branchId })
      .sort({ createdAt: -1 })
      .limit(TOP_UP_HISTORY_LIMIT)
      .exec();
  }

  async assertOwnsBranch(branchId: string, actorUid: string): Promise<void> {
    await this.loadOwnedBranch(branchId, actorUid);
  }

  private async loadOwnedBranch(
    branchId: string,
    actorUid: string,
  ): Promise<BranchDocument> {
    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch || branch.uid !== actorUid) {
      throw new ForbiddenException('You do not manage this branch');
    }
    return branch;
  }

  // -------------------------------------------------------------------------
  // Secure top-up lifecycle (RISK-P0-003)
  // -------------------------------------------------------------------------

  /**
   * Step 1 of the top-up flow: validate → create a PENDING TopUpIntent →
   * create a gateway invoice → return the intent (with checkout URL) for the
   * FE to open and poll. The wallet is NOT credited here — only
   * `postVerifiedTopUp` (webhook-verified, or the dev gateway's auto-succeed
   * shortcut through the same method) may credit.
   *
   * Canonical marketplace rule: funding is allowed for ANY active branch the
   * actor owns, regardless of KYC/verification state — verification gates the
   * badge, payment-readiness (₱1,000 activation) gates visibility. The
   * pre-Phase-2 `verificationStatus === APPROVED` funding gate is removed.
   */
  async initializeTopUp(
    branchId: string,
    amountCentavos: number,
    actorUid: string,
  ): Promise<TopUpIntent> {
    const branch = await this.loadOwnedBranch(branchId, actorUid);
    if (branch.isActive === false) {
      throw new ForbiddenException(
        'This branch is deactivated and cannot be funded',
      );
    }
    if (
      !Number.isInteger(amountCentavos) ||
      amountCentavos <= 0 ||
      amountCentavos > MAX_TOPUP_CENTAVOS
    ) {
      throw new BadRequestException(
        'Top-up amount must be a positive integer amount of centavos',
      );
    }

    // Lazy recovery for GAP-M-021: if branch creation succeeded but wallet
    // creation was lost, heal it here (idempotent upsert) before taking money.
    await this.createWallet(branchId);

    const intent = await this.topUpIntentModel.create({
      branchId,
      amountCentavos,
      status: TopUpIntentStatus.PENDING,
    });
    const intentId = String(intent._id);

    let invoice;
    try {
      invoice = await this.paymentGateway.createInvoice({
        intentId,
        branchId,
        amountCentavos,
        description: `LALABA wallet top-up — branch ${branchId}`,
      });
    } catch (err) {
      await this.topUpIntentModel
        .updateOne(
          { _id: intentId, status: TopUpIntentStatus.PENDING } as object,
          {
            $set: { status: TopUpIntentStatus.FAILED, resolvedAt: new Date() },
          },
        )
        .exec();
      throw err;
    }

    const updated = await this.topUpIntentModel
      .findOneAndUpdate(
        { _id: intentId } as object,
        {
          $set: {
            xenditInvoiceId: invoice.gatewayInvoiceId,
            invoiceUrl: invoice.invoiceUrl,
          },
        },
        { new: true },
      )
      .exec();

    if (invoice.autoSucceeds) {
      // DEV gateway only (never bound in production): settle immediately via
      // the exact same verified-posting path a webhook would use.
      const result = await this.postVerifiedTopUp(intentId, {
        reference: intentId,
        amountCentavos,
        currency: 'PHP',
        gatewayInvoiceId: invoice.gatewayInvoiceId,
      });
      return result.intent;
    }
    return updated!;
  }

  /** FE polling endpoint — owner-scoped read of one intent. */
  async topUpStatus(intentId: string, actorUid: string): Promise<TopUpIntent> {
    const intent = await this.topUpIntentModel.findById(intentId).exec();
    if (!intent) throw new NotFoundException('Top-up intent not found');
    await this.loadOwnedBranch(intent.branchId, actorUid);
    return intent;
  }

  /**
   * The ONLY code path that credits a wallet from a top-up. Called by the
   * Xendit webhook controller after token verification (and by the dev
   * gateway shortcut). Transactional: claim the PENDING intent, increment the
   * balance, stamp activation, append the ledger row — all or nothing.
   *
   * Idempotency, two layers:
   *  1. Atomic intent claim (`status: PENDING → SUCCEEDED`) — a replayed
   *     webhook finds no PENDING intent and reports alreadyPosted.
   *  2. Unique ledger index on (branchId, xenditReference) — even truly
   *     concurrent duplicates race down to a single committed credit; the
   *     loser's E11000 is caught and treated as already-posted.
   */
  async postVerifiedTopUp(
    intentId: string,
    event: VerifiedTopUpEvent,
  ): Promise<PostTopUpResult> {
    // findById throws a Mongoose CastError (uncaught -> 500) for a
    // non-ObjectId string rather than returning null, so a malformed
    // external_id — Xendit's own "test webhook" button sends one, and this
    // value is otherwise untrusted webhook input — must be rejected before
    // it reaches the query, not after.
    if (!isValidObjectId(intentId)) {
      throw new NotFoundException('Top-up intent not found');
    }
    const intent = await this.topUpIntentModel.findById(intentId).exec();
    if (!intent) throw new NotFoundException('Top-up intent not found');
    if (event.reference !== String(intent._id)) {
      throw new BadRequestException(
        'Payment reference does not match this top-up intent',
      );
    }
    if (event.currency !== 'PHP') {
      throw new BadRequestException(
        `Unsupported top-up currency: ${event.currency}`,
      );
    }
    if (event.amountCentavos !== intent.amountCentavos) {
      throw new BadRequestException(
        'Paid amount does not match the top-up intent amount',
      );
    }
    if (intent.status === TopUpIntentStatus.SUCCEEDED) {
      return { alreadyPosted: true, intent };
    }
    if (
      intent.status === TopUpIntentStatus.FAILED ||
      intent.status === TopUpIntentStatus.EXPIRED
    ) {
      throw new BadRequestException(
        `Top-up intent is ${intent.status} and can no longer be credited`,
      );
    }

    const session = await this.connection.startSession();
    let alreadyPosted = false;
    try {
      await session.withTransaction(async () => {
        const claimed = await this.topUpIntentModel
          .findOneAndUpdate(
            { _id: intentId, status: TopUpIntentStatus.PENDING } as object,
            {
              $set: {
                status: TopUpIntentStatus.SUCCEEDED,
                resolvedAt: new Date(),
                ...(event.gatewayInvoiceId
                  ? { xenditInvoiceId: event.gatewayInvoiceId }
                  : {}),
              },
            },
            { new: true, session },
          )
          .exec();
        if (!claimed) {
          alreadyPosted = true; // raced by a concurrent delivery
          return;
        }

        let wallet = await this.walletModel
          .findOneAndUpdate(
            { branchId: intent.branchId },
            { $inc: { balanceCentavos: intent.amountCentavos } },
            { new: true, session },
          )
          .exec();
        if (!wallet)
          throw new NotFoundException('Wallet not found for this branch');

        // Activate the account the first time the balance reaches the ₱1,000
        // onboarding minimum (payment-readiness marker; DECISION_REQUIRED-002
        // keeps the shipped value).
        if (
          !wallet.activatedAt &&
          wallet.balanceCentavos >= ACTIVATION_MIN_CENTAVOS
        ) {
          wallet = await this.walletModel
            .findOneAndUpdate(
              { branchId: intent.branchId },
              { $set: { activatedAt: new Date() } },
              { new: true, session },
            )
            .exec();
        }

        // Append-only ledger row; the unique (branchId, xenditReference)
        // index is the last-line duplicate barrier.
        await this.ledgerModel.create(
          [
            {
              branchId: intent.branchId,
              type: WalletLedgerEntryType.TOP_UP,
              amountCentavos: intent.amountCentavos,
              balanceAfterCentavos: wallet!.balanceCentavos,
              xenditReference: String(intent._id),
            },
          ],
          { session },
        );
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        this.logger.warn(
          `Duplicate top-up posting blocked by ledger unique index (intent ${intentId})`,
        );
        alreadyPosted = true;
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    const fresh = await this.topUpIntentModel.findById(intentId).exec();
    return { alreadyPosted, intent: fresh! };
  }

  /** Webhook-driven terminal states that never credit (EXPIRED / FAILED). */
  async resolveIntentWithoutCredit(
    intentId: string,
    status: TopUpIntentStatus.EXPIRED | TopUpIntentStatus.FAILED,
  ): Promise<TopUpIntent> {
    // Same CastError guard as postVerifiedTopUp — intentId is untrusted
    // webhook input here too.
    if (!isValidObjectId(intentId)) {
      throw new NotFoundException('Top-up intent not found');
    }
    const intent = await this.topUpIntentModel
      .findOneAndUpdate(
        { _id: intentId, status: TopUpIntentStatus.PENDING } as object,
        { $set: { status, resolvedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (intent) return intent;
    const existing = await this.topUpIntentModel.findById(intentId).exec();
    if (!existing) throw new NotFoundException('Top-up intent not found');
    return existing; // already terminal — idempotent no-op
  }

  /** Look up an intent for the webhook layer (no owner scoping — the caller
   * is the gateway, authenticated by callback token). */
  async findIntentById(intentId: string): Promise<TopUpIntent | null> {
    return this.topUpIntentModel.findById(intentId).exec();
  }

  // -------------------------------------------------------------------------
  // Balance checks / fee consumption (unchanged semantics)
  // -------------------------------------------------------------------------

  /** Per-order check at acceptance — balance just needs to cover this
   * specific order's estimated fee (§18). No flat minimum floor. */
  async hasSufficientBalance(
    branchId: string,
    estimatedFeeCentavos: number,
  ): Promise<boolean> {
    const wallet = await this.walletModel.findOne({ branchId }).exec();
    if (!wallet) return false;
    return wallet.balanceCentavos >= estimatedFeeCentavos;
  }

  /** While negative, new order acceptance is blocked (enforced by the
   * caller checking this before calling acceptOrder) — the in-flight order
   * that pushed it negative is never itself undone (§18). */
  async isBlocked(branchId: string): Promise<boolean> {
    const wallet = await this.walletModel.findOne({ branchId }).exec();
    return (wallet?.balanceCentavos ?? 0) < 0;
  }

  /** Deducts the actual fee once it's known at pickup/receipt — always
   * happens even if it pushes the balance negative; the pickup already
   * occurred and isn't undone retroactively (§18). */
  async consumeFee(
    branchId: string,
    amountCentavos: number,
    orderId: string,
    session: ClientSession,
  ): Promise<void> {
    const updated = await this.walletModel
      .findOneAndUpdate(
        { branchId },
        { $inc: { balanceCentavos: -amountCentavos } },
        { new: true, session },
      )
      .exec();
    if (!updated)
      throw new NotFoundException('Wallet not found for this branch');

    await this.ledgerModel.create(
      [
        {
          branchId,
          type: WalletLedgerEntryType.FEE_CONSUMPTION,
          amountCentavos: -amountCentavos,
          balanceAfterCentavos: updated.balanceCentavos,
          orderId,
        },
      ],
      { session },
    );
  }

  /**
   * Credits back a fee the provider fronted at pickup on an order the customer
   * then abandoned without ever paying (§14). The provider did the work, was
   * debited the platform's cut, and collected nothing — the platform earned
   * nothing either, so it returns what it took.
   *
   * Written only by the abandonment path. Callers must pass the amount actually
   * consumed (`pricing.platformFeeConsumedCentavos`), not the amount owed, or a
   * surcharge that was never debited would be refunded into existence.
   */
  async reverseFee(
    branchId: string,
    amountCentavos: number,
    orderId: string,
    session: ClientSession,
  ): Promise<void> {
    if (amountCentavos <= 0) return;

    const updated = await this.walletModel
      .findOneAndUpdate(
        { branchId },
        { $inc: { balanceCentavos: amountCentavos } },
        { new: true, session },
      )
      .exec();
    if (!updated)
      throw new NotFoundException('Wallet not found for this branch');

    await this.ledgerModel.create(
      [
        {
          branchId,
          type: WalletLedgerEntryType.FEE_REVERSAL,
          amountCentavos,
          balanceAfterCentavos: updated.balanceCentavos,
          orderId,
        },
      ],
      { session },
    );
  }

  /**
   * A manual correction, made by an admin outside the gateway/order-driven
   * paths — reserved for cases the ledger doesn't otherwise model (e.g.
   * making a provider whole after a platform-side billing mistake). Still
   * fully ledgered: same $inc-then-append-row shape as every other mutating
   * path here, so `reconciliationReport` never flags it as drift. The reason
   * lives on the admin-audit trail (via AdminAuditService), not on this row,
   * matching the convention that ledger entries never carry an actor.
   *
   * Never allowed to leave the balance negative — this is a correction, not
   * a way to claw back money the provider has already spent down.
   */
  async adminAdjustBalance(
    branchId: string,
    deltaCentavos: number,
  ): Promise<Wallet> {
    if (!Number.isInteger(deltaCentavos) || deltaCentavos === 0) {
      throw new BadRequestException(
        'Adjustment amount must be a non-zero whole number of centavos',
      );
    }

    const session = await this.connection.startSession();
    try {
      let result!: Wallet;
      await session.withTransaction(async () => {
        const existing = await this.walletModel
          .findOne({ branchId }, null, { session })
          .exec();
        if (!existing)
          throw new NotFoundException('Wallet not found for this branch');
        if (existing.balanceCentavos + deltaCentavos < 0) {
          throw new BadRequestException(
            'Adjustment would leave the wallet balance negative',
          );
        }

        const updated = await this.walletModel
          .findOneAndUpdate(
            { branchId },
            { $inc: { balanceCentavos: deltaCentavos } },
            { new: true, session },
          )
          .exec();
        if (!updated)
          throw new NotFoundException('Wallet not found for this branch');

        await this.ledgerModel.create(
          [
            {
              branchId,
              type: WalletLedgerEntryType.ADMIN_ADJUSTMENT,
              amountCentavos: deltaCentavos,
              balanceAfterCentavos: updated.balanceCentavos,
            },
          ],
          { session },
        );
        result = updated;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // -------------------------------------------------------------------------
  // Reconciliation groundwork
  // -------------------------------------------------------------------------

  /**
   * Recompute every wallet balance from its append-only ledger and report
   * variances. A healthy system reports zero wallets with variance; any
   * non-zero row means a balance was mutated outside the ledgered paths.
   */
  async reconciliationReport(): Promise<WalletReconciliationReport> {
    const [wallets, ledgerSums] = await Promise.all([
      this.walletModel.find().exec(),
      this.ledgerModel
        .aggregate<{ _id: string; total: number; count: number }>([
          {
            $group: {
              _id: '$branchId',
              total: { $sum: '$amountCentavos' },
              count: { $sum: 1 },
            },
          },
        ])
        .exec(),
    ]);
    const sums = new Map(ledgerSums.map((s) => [s._id, s]));

    const variances: WalletReconciliationRow[] = [];
    for (const wallet of wallets) {
      const sum = sums.get(wallet.branchId);
      const ledgerBalance = sum?.total ?? 0;
      const variance = wallet.balanceCentavos - ledgerBalance;
      if (variance !== 0) {
        variances.push({
          branchId: wallet.branchId,
          walletBalanceCentavos: wallet.balanceCentavos,
          ledgerBalanceCentavos: ledgerBalance,
          varianceCentavos: variance,
          ledgerEntryCount: sum?.count ?? 0,
        });
      }
    }
    return {
      generatedAt: new Date(),
      walletsChecked: wallets.length,
      walletsWithVariance: variances.length,
      variances,
    };
  }
}
