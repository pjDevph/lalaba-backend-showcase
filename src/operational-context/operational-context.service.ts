import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
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
} from '../support-tickets/schemas/support-ticket.schema';
import {
  ContextModuleKey,
  ContextSubjectType,
  OperationalContext,
} from './models/operational-context.model';

/**
 * THE MODULE AUTHORIZATION MATRIX.
 *
 * The security requirement for this whole feature, in one table: assembling
 * several records behind one address must not become a way to read something
 * the caller could not read on its own page.
 *
 * Each entry mirrors the guard on the resolver that already owns that data —
 * so `WALLET` is admin-only because WalletsAdminResolver is class-level
 * @Roles('admin'), which is also why wallet:read is not granted to support in
 * the panel's capability map. A support agent opening a provider's context
 * gets every module except the money, and the payload says so rather than
 * showing an empty wallet.
 *
 * A module the caller may not see is NEVER FETCHED. Fetching and then
 * stripping would leak existence through timing, and costs the query anyway.
 */
const MODULE_ROLES: Record<ContextModuleKey, string[]> = {
  // directoryUsers / listMerchants — ('admin', 'support')
  [ContextModuleKey.IDENTITY]: ['admin', 'support'],
  // adminOrders — ('admin', 'support')
  [ContextModuleKey.ORDERS]: ['admin', 'support'],
  // SupportTicketsResolver — class-level ('admin', 'support')
  [ContextModuleKey.TICKETS]: ['admin', 'support'],
  // WalletsAdminResolver — class-level ('admin'). The one real asymmetry.
  [ContextModuleKey.WALLET]: ['admin'],
  // kycProviders / kycReviewQueue — ('admin', 'support')
  [ContextModuleKey.KYC]: ['admin', 'support'],
  [ContextModuleKey.BRANCHES]: ['admin', 'support'],
  [ContextModuleKey.STAFF]: ['admin', 'support'],
};

/** Terminal states — everything else is an order still in flight. */
const CLOSED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.REJECTED_BY_PROVIDER,
];

/** Enough to answer "what is going on with them", not a report. */
const RECENT_LIMIT = 5;

@Injectable()
export class OperationalContextService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(KycDocument.name)
    private readonly kycModel: Model<KycDocumentDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(SupportTicket.name)
    private readonly ticketModel: Model<SupportTicketDocument>,
  ) {}

  /** Whether a role may see a module. Exposed so the resolver can be tested. */
  static maySee(module: ContextModuleKey, roleId: string): boolean {
    return MODULE_ROLES[module].includes(roleId);
  }

  async build(
    subjectType: ContextSubjectType,
    id: string,
    roleId: string,
  ): Promise<OperationalContext> {
    return subjectType === ContextSubjectType.BRANCH
      ? this.buildBranch(id, roleId)
      : this.buildPerson(id, roleId);
  }

  // ── Person ────────────────────────────────────────────────────────────────

  private async buildPerson(
    uid: string,
    roleId: string,
  ): Promise<OperationalContext> {
    const user = await this.userModel.findById(uid).populate('role').exec();
    if (!user) throw new NotFoundException('Account not found');

    const role = user.role as unknown as Role | undefined;
    const subjectRoleId = role?.roleId ?? null;

    const modules: ContextModuleKey[] = [ContextModuleKey.IDENTITY];
    const context: OperationalContext = {
      subjectType: ContextSubjectType.PERSON,
      identity: {
        id: String(user._id),
        displayName:
          `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
          user.email ||
          String(user._id),
        email: user.email ?? null,
        phone: user.phoneNumber ?? null,
        roleId: subjectRoleId,
        isActive: user.isActive,
        accountStatus: user.accountStatus ?? null,
        joinedAt: user.createdAt ?? null,
      },
      modules,
    };

    // A provider's own bookable branches. For a home washer this is her single
    // anchor branch — created so the shared inventory/product FK chain works —
    // not a business with locations, which is why nothing here offers to add
    // one.
    const isProvider =
      subjectRoleId === 'merchant' || subjectRoleId === 'washer';
    const branchIds = isProvider ? await this.branchIdsFor(uid) : [];

    const may = (module: ContextModuleKey) =>
      OperationalContextService.maySee(module, roleId);

    const [orders, tickets, wallet, kyc, branches, staff] = await Promise.all([
      may(ContextModuleKey.ORDERS) ? this.ordersFor({ personUid: uid }) : null,
      may(ContextModuleKey.TICKETS) ? this.ticketsFor(uid) : null,
      may(ContextModuleKey.WALLET) && branchIds.length
        ? this.walletFor(branchIds[0])
        : null,
      may(ContextModuleKey.KYC) && isProvider ? this.kycFor(uid) : null,
      may(ContextModuleKey.BRANCHES) && isProvider
        ? this.branchesFor(branchIds)
        : null,
      may(ContextModuleKey.STAFF) && subjectRoleId === 'merchant'
        ? this.staffFor(uid)
        : null,
    ]);

    // A module appears in `modules` only when it was BOTH permitted and
    // applicable — so the panel can say "no wallet on this account" and
    // "you may not see wallets" as different sentences.
    if (orders) {
      context.orders = orders;
      modules.push(ContextModuleKey.ORDERS);
    }
    if (tickets) {
      context.tickets = tickets;
      modules.push(ContextModuleKey.TICKETS);
    }
    if (wallet) {
      context.wallet = wallet;
      modules.push(ContextModuleKey.WALLET);
    }
    if (kyc) {
      context.kyc = kyc;
      modules.push(ContextModuleKey.KYC);
    }
    if (branches) {
      context.branches = branches;
      modules.push(ContextModuleKey.BRANCHES);
    }
    if (staff) {
      context.staff = staff;
      modules.push(ContextModuleKey.STAFF);
    }

    return context;
  }

  // ── Branch ────────────────────────────────────────────────────────────────

  private async buildBranch(
    branchId: string,
    roleId: string,
  ): Promise<OperationalContext> {
    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch) throw new NotFoundException('Branch not found');

    const owner = await this.userModel.findById(branch.uid).exec();
    const modules: ContextModuleKey[] = [ContextModuleKey.IDENTITY];

    const context: OperationalContext = {
      subjectType: ContextSubjectType.BRANCH,
      identity: {
        id: String(branch._id),
        displayName: branch.branchName,
        branchName: branch.branchName,
        email: owner?.email ?? null,
        phone: owner?.phoneNumber ?? null,
        roleId: null,
        isActive: branch.isActive,
        accountStatus: null,
        joinedAt: branch.createdAt ?? null,
      },
      modules,
    };

    const may = (module: ContextModuleKey) =>
      OperationalContextService.maySee(module, roleId);

    const [orders, wallet] = await Promise.all([
      may(ContextModuleKey.ORDERS) ? this.ordersFor({ branchId }) : null,
      may(ContextModuleKey.WALLET) ? this.walletFor(branchId) : null,
    ]);

    if (orders) {
      context.orders = orders;
      modules.push(ContextModuleKey.ORDERS);
    }
    if (wallet) {
      context.wallet = wallet;
      modules.push(ContextModuleKey.WALLET);
    }

    return context;
  }

  // ── Modules ───────────────────────────────────────────────────────────────

  /**
   * Orders, from whichever side of them this subject sits on.
   *
   * A person matches as customer OR provider, deliberately: "find their
   * orders" means the same thing whichever end they are, and an operator
   * should not have to know which before asking.
   */
  private async ordersFor(subject: { personUid?: string; branchId?: string }) {
    const match = subject.branchId
      ? { 'provider.branchId': subject.branchId }
      : {
          $or: [
            { 'customer.uid': subject.personUid },
            { 'provider.providerUid': subject.personUid },
          ],
        };

    const [rows, totals] = await Promise.all([
      this.orderModel
        .find(match)
        .sort({ createdAt: -1 })
        .limit(RECENT_LIMIT)
        .exec(),
      this.orderModel
        .aggregate<{
          _id: null;
          total: number;
          open: number;
          outstanding: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              open: {
                $sum: {
                  $cond: [{ $in: ['$status', CLOSED_ORDER_STATUSES] }, 0, 1],
                },
              },
              // The two amounts live in different sub-documents, so this is
              // the same $subtract the unsettled-orders queue does rather
              // than a stored field.
              outstanding: {
                $sum: {
                  $max: [
                    0,
                    {
                      $subtract: [
                        { $ifNull: ['$pricing.customerTotalCentavos', 0] },
                        {
                          $ifNull: [
                            '$paymentSummary.amountCollectedCentavos',
                            0,
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ])
        .exec(),
    ]);

    const summary = totals[0];
    return {
      total: summary?.total ?? 0,
      open: summary?.open ?? 0,
      outstandingCentavos: Math.round(summary?.outstanding ?? 0),
      recent: rows.map((order) => ({
        id: String(order._id),
        orderNumber: order.orderNumber ?? null,
        status: order.status,
        // Whichever side the subject is NOT — the useful column is who they
        // dealt with, not their own name repeated down the page.
        counterpartyName: subject.branchId
          ? (order.customer?.displayName ?? '—')
          : order.customer?.uid === subject.personUid
            ? (order.provider?.providerName ?? '—')
            : (order.customer?.displayName ?? '—'),
        totalCentavos: Math.round(order.pricing?.customerTotalCentavos ?? 0),
        collectedCentavos: Math.round(
          order.paymentSummary?.amountCollectedCentavos ?? 0,
        ),
        createdAt: order.createdAt ?? null,
      })),
    };
  }

  private async ticketsFor(uid: string) {
    const [rows, total, open] = await Promise.all([
      this.ticketModel
        .find({ 'requester.uid': uid })
        .sort({ createdAt: -1 })
        .limit(RECENT_LIMIT)
        .exec(),
      this.ticketModel.countDocuments({ 'requester.uid': uid }).exec(),
      this.ticketModel
        .countDocuments({
          'requester.uid': uid,
          status: { $in: TICKET_ACTIVE_STATUSES },
        })
        .exec(),
    ]);

    return {
      total,
      open,
      recent: rows.map((ticket) => ({
        id: String(ticket._id),
        ticketNumber: ticket.ticketNumber ?? null,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt ?? null,
      })),
    };
  }

  private async walletFor(branchId: string) {
    const wallet = await this.walletModel.findOne({ branchId }).exec();
    if (!wallet) return null;
    return {
      branchId,
      balanceCentavos: wallet.balanceCentavos,
      activated: wallet.activatedAt != null,
    };
  }

  private async kycFor(ownerUid: string) {
    const documents = await this.kycModel
      .find({ ownerUid })
      .sort({ createdAt: -1 })
      .exec();
    if (documents.length === 0) return null;

    const count = (status: KycDocumentStatus) =>
      documents.filter((d) => d.status === status).length;

    return {
      submitted: count(KycDocumentStatus.SUBMITTED),
      approved: count(KycDocumentStatus.APPROVED),
      rejected: count(KycDocumentStatus.REJECTED),
      documents: documents.slice(0, RECENT_LIMIT).map((doc) => ({
        id: String(doc._id),
        documentType: doc.documentType,
        status: doc.status,
        submittedAt: doc.createdAt ?? null,
      })),
    };
  }

  /** Every branch this person owns, plus a washer's anchor branch. */
  private async branchIdsFor(uid: string): Promise<string[]> {
    const [branches, washer] = await Promise.all([
      this.branchModel.find({ uid }).select('_id').exec(),
      this.washerModel.findOne({ uid }).select('branchId').exec(),
    ]);
    const ids = branches.map((b) => String(b._id));
    if (washer?.branchId && !ids.includes(washer.branchId)) {
      ids.push(washer.branchId);
    }
    return ids;
  }

  private async branchesFor(branchIds: string[]) {
    if (branchIds.length === 0) return null;
    const branches = await this.branchModel
      .find({
        _id: {
          $in: branchIds as unknown as BranchDocument['_id'][],
        },
      })
      .exec();
    return branches.map((branch) => ({
      id: String(branch._id),
      branchName: branch.branchName,
      isActive: branch.isActive,
    }));
  }

  /** A merchant's branch staff. Home washers have none. */
  private async staffFor(merchantUid: string) {
    const staff = await this.userModel
      .find({ merchantId: merchantUid })
      .limit(25)
      .exec();
    if (staff.length === 0) return null;
    return staff.map((member) => ({
      id: String(member._id),
      displayName:
        `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim() ||
        member.email,
      email: member.email ?? null,
      isActive: member.isActive,
    }));
  }
}
