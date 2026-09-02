import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../users/schemas/user.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntryDocument,
} from '../wallets/schemas/wallet-ledger-entry.schema';
import {
  KycDocument,
  KycDocumentDocument,
  KycDocumentStatus,
} from '../kyc/schemas/kyc-document.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import { OrderStatus } from '../online-orders/schemas/order-status.enum';
import {
  SupportTicket,
  SupportTicketDocument,
  TICKET_ACTIVE_STATUSES,
  TicketPriority,
} from '../support-tickets/schemas/support-ticket.schema';
import {
  NowQueue,
  WorkItem,
  WorkItemType,
  WorkPriority,
  WorkSubjectType,
} from './models/work-item.model';

/**
 * Which roles may look for which kind of work.
 *
 * Same shape and same reason as the operational context's module matrix: this
 * query reaches across several collections at once and must not become a way
 * around a guard a dedicated resolver still enforces. A type the caller may
 * not see is never queried, and `searchedTypes` reports what was.
 */
const TYPE_ROLES: Record<WorkItemType, string[]> = {
  [WorkItemType.TICKET_OVERDUE]: ['admin', 'support'],
  [WorkItemType.TICKET_UNASSIGNED]: ['admin', 'support'],
  [WorkItemType.KYC_AWAITING_REVIEW]: ['admin', 'support'],
  [WorkItemType.ORDER_STUCK]: ['admin', 'support'],
  [WorkItemType.ORDER_UNSETTLED]: ['admin', 'support'],
  // Wallet reads are admin-only (WalletsAdminResolver is class-level
  // @Roles('admin')), so support's Now never contains a money row — the same
  // asymmetry the operational context has.
  [WorkItemType.WALLET_VARIANCE]: ['admin'],
};

/**
 * The first-response targets. Imported in spirit from SupportTicketsService,
 * which owns them — the numbers are not redefined here, only read through
 * `firstResponseDueAt`-equivalent arithmetic on the same fields, so a change
 * there changes this.
 */
const FIRST_RESPONSE_TARGET_MINUTES: Record<TicketPriority, number> = {
  [TicketPriority.URGENT]: 30,
  [TicketPriority.HIGH]: 2 * 60,
  [TicketPriority.NORMAL]: 8 * 60,
  [TicketPriority.LOW]: 24 * 60,
};

/**
 * How long an order may sit waiting for a provider before it is a problem.
 *
 * A working number, not a contractual one — and it lives here rather than in
 * the panel because "stuck" is a fact about Lalaba's operations. Put it in
 * React and one screen's two hours becomes another's three.
 */
const PROVIDER_ACCEPTANCE_GRACE_MINUTES = 2 * 60;

/** States where the platform is waiting on the provider to do something. */
const AWAITING_PROVIDER: OrderStatus[] = [
  OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
  OrderStatus.PROVIDER_CHANGE_PROPOSED,
];

/** Per-source cap. This is a page you scan, not a report you work through. */
const PER_SOURCE_LIMIT = 10;

@Injectable()
export class NowQueueService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(WalletLedgerEntry.name)
    private readonly ledgerModel: Model<WalletLedgerEntryDocument>,
    @InjectModel(KycDocument.name)
    private readonly kycModel: Model<KycDocumentDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(SupportTicket.name)
    private readonly ticketModel: Model<SupportTicketDocument>,
  ) {}

  static maySee(type: WorkItemType, roleId: string): boolean {
    return TYPE_ROLES[type].includes(roleId);
  }

  async build(roleId: string, now = new Date()): Promise<NowQueue> {
    const searchedTypes = (Object.keys(TYPE_ROLES) as WorkItemType[]).filter(
      (type) => TYPE_ROLES[type].includes(roleId),
    );
    const may = (type: WorkItemType) => searchedTypes.includes(type);

    // Independent sources, run together. One that fails must not empty the
    // whole page — a Now missing its wallet row is useful; a Now that is an
    // error message is not.
    const groups = await Promise.all([
      this.settled(may(WorkItemType.TICKET_OVERDUE) ? this.tickets(now) : null),
      this.settled(
        may(WorkItemType.KYC_AWAITING_REVIEW) ? this.kyc(now) : null,
      ),
      this.settled(
        may(WorkItemType.ORDER_STUCK) ? this.stuckOrders(now) : null,
      ),
      this.settled(
        may(WorkItemType.ORDER_UNSETTLED) ? this.unsettledOrders(now) : null,
      ),
      this.settled(
        may(WorkItemType.WALLET_VARIANCE) ? this.walletVariances(now) : null,
      ),
    ]);

    const truncated = groups.some((g) => g.length >= PER_SOURCE_LIMIT);

    const items = groups.flat().sort(
      (a, b) =>
        rankOf(a.priority) - rankOf(b.priority) ||
        // Within a priority, whatever has been waiting longest — the row
        // most likely to become a complaint if it waits any longer.
        (b.overdueMinutes ?? b.ageMinutes ?? 0) -
          (a.overdueMinutes ?? a.ageMinutes ?? 0),
    );

    return { items, searchedTypes, truncated, generatedAt: now };
  }

  private async settled(promise: Promise<WorkItem[]> | null) {
    if (!promise) return [];
    try {
      return await promise;
    } catch {
      return [];
    }
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  /**
   * Tickets that have had no first reply.
   *
   * Overdue against the per-priority target becomes HIGH; unassigned but still
   * inside its target is MEDIUM. Age alone would be the wrong sort: an
   * hour-old urgent ticket is late while a day-old low one is fine, which is
   * exactly why the inbox shows time REMAINING rather than time elapsed.
   */
  private async tickets(now: Date): Promise<WorkItem[]> {
    const tickets = await this.ticketModel
      .find({
        status: { $in: TICKET_ACTIVE_STATUSES },
        $or: [
          { firstResponseAt: null },
          { firstResponseAt: { $exists: false } },
        ],
      })
      .sort({ createdAt: 1 })
      .limit(PER_SOURCE_LIMIT)
      .exec();

    const assigneeNames = await this.namesFor(
      tickets.map((t) => t.assignedToUid).filter((u): u is string => !!u),
    );

    return tickets.map((ticket) => {
      const createdAt = ticket.createdAt ?? now;
      const targetMinutes =
        FIRST_RESPONSE_TARGET_MINUTES[ticket.priority] ?? 8 * 60;
      const dueAt = new Date(createdAt.getTime() + targetMinutes * 60_000);
      const overdueMinutes = Math.round(
        (now.getTime() - dueAt.getTime()) / 60_000,
      );
      const isOverdue = overdueMinutes > 0;
      const unassigned = !ticket.assignedToUid;

      return {
        id: `ticket:${String(ticket._id)}`,
        type: isOverdue
          ? WorkItemType.TICKET_OVERDUE
          : WorkItemType.TICKET_UNASSIGNED,
        priority: isOverdue
          ? WorkPriority.HIGH
          : unassigned
            ? WorkPriority.MEDIUM
            : WorkPriority.LOW,
        title: ticket.ticketNumber
          ? `${ticket.ticketNumber} — ${ticket.subject}`
          : ticket.subject,
        reason: isOverdue
          ? `First reply overdue by ${humanMinutes(overdueMinutes)}`
          : unassigned
            ? 'Waiting for a first reply, nobody assigned'
            : 'Waiting for a first reply',
        subjectType: WorkSubjectType.TICKET,
        subjectId: String(ticket._id),
        enteredQueueAt: createdAt,
        ageMinutes: minutesBetween(createdAt, now),
        dueAt,
        overdueMinutes,
        assigneeName: ticket.assignedToUid
          ? (assigneeNames.get(ticket.assignedToUid) ?? null)
          : null,
        amountCentavos: null,
      };
    });
  }

  // ── KYC ───────────────────────────────────────────────────────────────────

  /** Documents submitted and not yet claimed by a reviewer. */
  private async kyc(now: Date): Promise<WorkItem[]> {
    const documents = await this.kycModel
      .find({
        status: KycDocumentStatus.SUBMITTED,
        $or: [{ claimedByUid: null }, { claimedByUid: { $exists: false } }],
      })
      .sort({ createdAt: 1 })
      .limit(PER_SOURCE_LIMIT)
      .exec();

    return documents.map((doc) => {
      const submittedAt = doc.createdAt ?? now;
      const ageMinutes = minutesBetween(submittedAt, now);
      return {
        id: `kyc:${String(doc._id)}`,
        type: WorkItemType.KYC_AWAITING_REVIEW,
        // A provider waiting on verification cannot earn. A day is the point
        // at which that stops being a queue and starts being a complaint.
        priority:
          ageMinutes > 24 * 60 ? WorkPriority.HIGH : WorkPriority.MEDIUM,
        title: doc.documentType.replaceAll('_', ' ').toLowerCase(),
        reason: `Submitted ${humanMinutes(ageMinutes)} ago, unclaimed`,
        subjectType: WorkSubjectType.PERSON,
        subjectId: doc.ownerUid,
        enteredQueueAt: submittedAt,
        ageMinutes,
        dueAt: null,
        overdueMinutes: null,
        assigneeName: null,
        amountCentavos: null,
      };
    });
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  /** Sitting on a provider who has not responded. */
  private async stuckOrders(now: Date): Promise<WorkItem[]> {
    const cutoff = new Date(
      now.getTime() - PROVIDER_ACCEPTANCE_GRACE_MINUTES * 60_000,
    );
    const orders = await this.orderModel
      .find({ status: { $in: AWAITING_PROVIDER }, updatedAt: { $lte: cutoff } })
      .sort({ updatedAt: 1 })
      .limit(PER_SOURCE_LIMIT)
      .exec();

    return orders.map((order) => {
      const since = order.updatedAt ?? order.createdAt ?? now;
      const ageMinutes = minutesBetween(since, now);
      return {
        id: `order-stuck:${String(order._id)}`,
        type: WorkItemType.ORDER_STUCK,
        priority: ageMinutes > 6 * 60 ? WorkPriority.HIGH : WorkPriority.MEDIUM,
        title: order.orderNumber ?? `Order ${String(order._id).slice(-6)}`,
        reason: `Waiting for provider acceptance for ${humanMinutes(ageMinutes)}`,
        subjectType: WorkSubjectType.ORDER,
        subjectId: String(order._id),
        enteredQueueAt: since,
        ageMinutes,
        dueAt: null,
        overdueMinutes: ageMinutes - PROVIDER_ACCEPTANCE_GRACE_MINUTES,
        assigneeName: order.provider?.providerName ?? null,
        amountCentavos: Math.round(order.pricing?.customerTotalCentavos ?? 0),
      };
    });
  }

  /** Money the platform is owed, and how long before the sweep gives up. */
  private async unsettledOrders(now: Date): Promise<WorkItem[]> {
    const orders = await this.orderModel
      .find({
        $or: [
          { status: OrderStatus.ABANDONED_UNSETTLED },
          {
            abandonmentDeadlineAt: { $ne: null },
            $expr: {
              $gt: [
                { $ifNull: ['$pricing.customerTotalCentavos', 0] },
                { $ifNull: ['$paymentSummary.amountCollectedCentavos', 0] },
              ],
            },
          },
        ],
      })
      .sort({ abandonmentDeadlineAt: 1 })
      .limit(PER_SOURCE_LIMIT)
      .exec();

    return orders.map((order) => {
      const outstanding = Math.max(
        0,
        Math.round(
          (order.pricing?.customerTotalCentavos ?? 0) -
            (order.paymentSummary?.amountCollectedCentavos ?? 0),
        ),
      );
      const deadline = order.abandonmentDeadlineAt ?? null;
      const minutesLeft = deadline ? minutesBetween(now, deadline) : null;

      return {
        id: `order-unsettled:${String(order._id)}`,
        type: WorkItemType.ORDER_UNSETTLED,
        // Once the sweep has passed, chasing it is the only way the money
        // comes back — so an expired deadline outranks one still running.
        priority:
          minutesLeft !== null && minutesLeft < 24 * 60
            ? WorkPriority.HIGH
            : WorkPriority.MEDIUM,
        title: order.orderNumber ?? `Order ${String(order._id).slice(-6)}`,
        reason:
          minutesLeft === null
            ? 'Unsettled, no sweep deadline'
            : minutesLeft <= 0
              ? 'Sweep deadline passed'
              : `Sweep gives up in ${humanMinutes(minutesLeft)}`,
        subjectType: WorkSubjectType.ORDER,
        subjectId: String(order._id),
        enteredQueueAt: order.updatedAt ?? null,
        ageMinutes: order.updatedAt
          ? minutesBetween(order.updatedAt, now)
          : null,
        dueAt: deadline,
        overdueMinutes: minutesLeft === null ? null : -minutesLeft,
        assigneeName: order.customer?.displayName ?? null,
        amountCentavos: outstanding,
      };
    });
  }

  // ── Wallets ───────────────────────────────────────────────────────────────

  /**
   * Wallets whose stored balance disagrees with their own ledger.
   *
   * Admin-only, and always HIGH: a balance that moved outside the ledgered
   * paths is the one thing on this page that means the books are wrong rather
   * than that someone is waiting.
   */
  private async walletVariances(now: Date): Promise<WorkItem[]> {
    const [wallets, sums] = await Promise.all([
      this.walletModel.find().limit(500).exec(),
      this.ledgerModel
        .aggregate<{ _id: string; total: number }>([
          { $group: { _id: '$branchId', total: { $sum: '$amountCentavos' } } },
        ])
        .exec(),
    ]);
    const ledgerByBranch = new Map(sums.map((s) => [s._id, s.total]));

    return wallets
      .map((wallet) => ({
        wallet,
        variance:
          wallet.balanceCentavos - (ledgerByBranch.get(wallet.branchId) ?? 0),
      }))
      .filter((row) => row.variance !== 0)
      .slice(0, PER_SOURCE_LIMIT)
      .map(({ wallet, variance }) => ({
        id: `wallet-variance:${wallet.branchId}`,
        type: WorkItemType.WALLET_VARIANCE,
        priority: WorkPriority.HIGH,
        title: 'Ledger variance',
        reason: `A stored balance disagrees with its ledger by ${formatPeso(variance)}`,
        subjectType: WorkSubjectType.BRANCH,
        subjectId: wallet.branchId,
        enteredQueueAt: null,
        ageMinutes: null,
        dueAt: null,
        overdueMinutes: null,
        assigneeName: null,
        amountCentavos: variance,
      }));
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  private async namesFor(uids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(uids)];
    if (unique.length === 0) return new Map();
    const users = await this.userModel
      .find({ _id: { $in: unique as unknown as UserDocument['_id'][] } })
      .select('firstName lastName')
      .exec();
    return new Map(
      users.map((u) => [
        String(u._id),
        `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
      ]),
    );
  }
}

function rankOf(priority: WorkPriority): number {
  return priority === WorkPriority.HIGH
    ? 0
    : priority === WorkPriority.MEDIUM
      ? 1
      : 2;
}

function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

/** "2h 14m" — the form the reason strings read in. */
function humanMinutes(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs < 60) return `${abs}m`;
  const hours = Math.floor(abs / 60);
  if (hours < 24) {
    const rest = abs % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function formatPeso(centavos: number): string {
  const sign = centavos < 0 ? '−' : '';
  return `${sign}₱${(Math.abs(centavos) / 100).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
