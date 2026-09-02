import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../users/schemas/user.schema';
import { Role, RoleDocument } from '../users/schemas/role.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
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
  SearchEntityType,
  SearchResult,
  OperationalSearchResults,
} from './models/search-result.model';
import {
  MatchStrength,
  MatchedOn,
  classifyTerm,
  escapeTerm,
  rankOf,
  strengthOfNameMatch,
  type TermShape,
} from './term.util';

/**
 * ONE SEARCH BOX OVER THE WHOLE BACK OFFICE.
 *
 * Before this, every surface searched separately: orders by phone/name/number,
 * the account directory by name/email/uid, tickets by number/subject, each on
 * its own page. An agent answering a call holds a phone number and has to
 * decide which section owns it BEFORE they can type it — which means knowing
 * how Lalaba stores things in order to ask Lalaba a question.
 *
 * Deliberately one backend contract rather than several client calls merged in
 * the browser. Merging on the client would mean the ranking lives in React
 * (so every surface ranks differently), the permission decision is made after
 * the data has already been fetched, and adding an entity type is a frontend
 * change. Most concretely: a phone number cannot be resolved client-side at
 * all — an order stores only a masked phone, so the digits a customer reads
 * out have to be matched against the USER record and joined back to orders
 * server-side. That single fact settles the architecture.
 */

/** Terminal states. Everything else is an order still in flight. */
const CLOSED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.REJECTED_BY_PROVIDER,
];

/**
 * Per-type cap. Small on purpose: this feeds a dropdown an operator scans in
 * one glance, not a report. Hitting it sets `truncated`, so the UI can say so
 * rather than implying the list is complete.
 */
const PER_TYPE_LIMIT = 5;

/**
 * Which roles may search which entity type — mirroring the resolver guards
 * that already own these collections, since this query reaches across all of
 * them at once and must not become a way around any of them.
 *
 * A type the caller cannot search is not searched at all, rather than searched
 * and filtered afterwards: the second shape leaks existence through timing and
 * counts, and costs the query anyway.
 */
const TYPE_ROLES: Record<SearchEntityType, string[]> = {
  // directoryUsers is @Roles('admin', 'support')
  [SearchEntityType.CUSTOMER]: ['admin', 'support'],
  [SearchEntityType.BACK_OFFICE]: ['admin', 'support'],
  [SearchEntityType.PROVIDER]: ['admin', 'support'],
  [SearchEntityType.STAFF]: ['admin', 'support'],
  [SearchEntityType.COURIER]: ['admin', 'support'],
  // bookingProviders is @Roles('admin', 'support')
  [SearchEntityType.BRANCH]: ['admin', 'support'],
  // adminOrders is @Roles('admin', 'support')
  [SearchEntityType.ORDER]: ['admin', 'support'],
  // SupportTicketsResolver is class-level @Roles('admin', 'support')
  [SearchEntityType.TICKET]: ['admin', 'support'],
};

/** Account role → the result type it should be reported as. */
const ROLE_TO_ENTITY: Record<string, SearchEntityType> = {
  customer: SearchEntityType.CUSTOMER,
  merchant: SearchEntityType.PROVIDER,
  washer: SearchEntityType.PROVIDER,
  staff: SearchEntityType.STAFF,
  courier: SearchEntityType.COURIER,
  admin: SearchEntityType.BACK_OFFICE,
  support: SearchEntityType.BACK_OFFICE,
};

/**
 * Tie-break when two results matched equally well — a name that is both a
 * customer's and their order's, a phone that is both a provider's and one on
 * their order.
 *
 * Subjects before records about them. An operator who searched a person is
 * looking for the person; the order is what they will open NEXT, from the
 * person. It is also where this is going: the Phase 1B operational context is
 * built around a subject, so ranking one first is the same answer the whole
 * redesign gives.
 */
const TIE_BREAK: SearchEntityType[] = [
  SearchEntityType.CUSTOMER,
  SearchEntityType.PROVIDER,
  SearchEntityType.BRANCH,
  SearchEntityType.STAFF,
  SearchEntityType.COURIER,
  SearchEntityType.BACK_OFFICE,
  SearchEntityType.ORDER,
  SearchEntityType.TICKET,
];

type Ranked = SearchResult & { rank: number };

@Injectable()
export class SearchService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(SupportTicket.name)
    private readonly ticketModel: Model<SupportTicketDocument>,
  ) {}

  async search(
    rawQuery: string,
    roleId: string,
    limit = 20,
  ): Promise<OperationalSearchResults> {
    const term = classifyTerm(rawQuery);

    // Two characters finds everyone, which is not a search result, it is the
    // database. An empty answer here is correct rather than unhelpful.
    if (term.normalized.length < 3) {
      return { results: [], searchedTypes: [], truncated: false };
    }

    const searchedTypes = (
      Object.keys(TYPE_ROLES) as SearchEntityType[]
    ).filter((type) => TYPE_ROLES[type].includes(roleId));

    const may = (type: SearchEntityType) => searchedTypes.includes(type);

    // Every searcher runs concurrently and independently. One that throws
    // must not take the whole box down with it — a search that returns four
    // of five kinds is useful; one that returns an error is not.
    const [accounts, branches, orders, tickets] = await Promise.all([
      this.settled(
        may(SearchEntityType.CUSTOMER) ? this.searchAccounts(term) : null,
      ),
      this.settled(
        may(SearchEntityType.BRANCH) ? this.searchBranches(term) : null,
      ),
      this.settled(
        may(SearchEntityType.ORDER) ? this.searchOrders(term) : null,
      ),
      this.settled(
        may(SearchEntityType.TICKET) ? this.searchTickets(term) : null,
      ),
    ]);

    const all = [...accounts, ...branches, ...orders, ...tickets]
      // Account results are typed by role, and a role the caller may not
      // search is dropped here rather than never fetched — they all come from
      // one users query, so splitting it would cost more than it protects.
      .filter((r) => searchedTypes.includes(r.entityType));

    const truncated =
      accounts.length >= PER_TYPE_LIMIT ||
      branches.length >= PER_TYPE_LIMIT ||
      orders.length >= PER_TYPE_LIMIT ||
      tickets.length >= PER_TYPE_LIMIT;

    const results = all
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          TIE_BREAK.indexOf(a.entityType) - TIE_BREAK.indexOf(b.entityType) ||
          a.title.localeCompare(b.title),
      )
      .slice(0, limit)
      .map(({ rank: _rank, ...result }) => result);

    return { results, searchedTypes, truncated };
  }

  /** Resolves to [] instead of rejecting — see the note at the call site. */
  private async settled(promise: Promise<Ranked[]> | null): Promise<Ranked[]> {
    if (!promise) return [];
    try {
      return await promise;
    } catch {
      return [];
    }
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  private async searchAccounts(term: TermShape): Promise<Ranked[]> {
    const clauses: Record<string, unknown>[] = [];

    if (term.email) clauses.push({ email: term.email });
    if (term.phoneTail) {
      clauses.push({
        phoneNumber: { $regex: `${escapeTerm(term.phoneTail)}$` },
      });
    }
    if (term.objectId) clauses.push({ _id: term.objectId });
    if (term.firebaseUid) clauses.push({ _id: term.firebaseUid });

    // A name search is the fallback, not an addition: when the operator pasted
    // an identifier, matching names too would bury the exact hit under
    // coincidences.
    if (clauses.length === 0) {
      const pattern = { $regex: escapeTerm(term.name), $options: 'i' };
      clauses.push(
        { firstName: pattern },
        { lastName: pattern },
        { email: pattern },
      );

      // A full name has to be matched across BOTH fields or it matches
      // neither. The first end-to-end run found the ORDER for "PJ Tester" —
      // whose snapshot stores one displayName — and not the person, because
      // no single field on the user record contains "PJ Tester". Typing
      // someone's whole name is the most natural thing an operator does.
      const words = term.name.split(' ').filter(Boolean);
      if (words.length > 1) {
        const first = { $regex: `^${escapeTerm(words[0])}`, $options: 'i' };
        const last = {
          $regex: `^${escapeTerm(words[words.length - 1])}`,
          $options: 'i',
        };
        clauses.push({ $and: [{ firstName: first }, { lastName: last }] });
      }
    }

    const users = await this.userModel
      .find({ $or: clauses })
      .populate('role')
      .limit(PER_TYPE_LIMIT)
      .exec();
    if (users.length === 0) return [];

    const openOrders = await this.openOrderCounts(
      users.map((u) => String(u._id)),
    );

    return users.map((user) => {
      const role = user.role as unknown as Role | undefined;
      const roleId = role?.roleId ?? '';
      const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
      const { matchedOn, matchStrength } = this.matchOf(term, {
        email: user.email,
        phone: user.phoneNumber,
        id: String(user._id),
        name,
      });

      return {
        entityType: ROLE_TO_ENTITY[roleId] ?? SearchEntityType.CUSTOMER,
        id: String(user._id),
        title: name || user.email || String(user._id),
        // The phone is the thing an agent is holding, so it is what confirms
        // they picked the right person.
        subtitle: [user.phoneNumber, user.email].filter(Boolean).join(' · '),
        matchedOn,
        matchStrength,
        context: {
          openOrders: openOrders.get(String(user._id)) ?? 0,
          status: user.isActive ? 'ACTIVE' : 'INACTIVE',
        },
        rank: rankOf(matchedOn, matchStrength),
      };
    });
  }

  /** In-flight orders per customer uid, in one aggregation for the whole page. */
  private async openOrderCounts(uids: string[]): Promise<Map<string, number>> {
    if (uids.length === 0) return new Map();
    const rows = await this.orderModel
      .aggregate<{ _id: string; n: number }>([
        {
          $match: {
            'customer.uid': { $in: uids },
            status: { $nin: CLOSED_ORDER_STATUSES },
          },
        },
        { $group: { _id: '$customer.uid', n: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((r) => [r._id, r.n]));
  }

  // ── Branches ──────────────────────────────────────────────────────────────

  private async searchBranches(term: TermShape): Promise<Ranked[]> {
    const clauses: Record<string, unknown>[] = [];
    if (term.objectId) clauses.push({ _id: term.objectId });
    if (clauses.length === 0) {
      clauses.push({
        branchName: { $regex: escapeTerm(term.name), $options: 'i' },
      });
    }

    const branches = await this.branchModel
      .find({ $or: clauses })
      .limit(PER_TYPE_LIMIT)
      .exec();
    if (branches.length === 0) return [];

    // One query for every owner on the page rather than a populate per row.
    const owners = await this.userModel
      // Cast for the same reason the order search casts: the schema declares
      // `_id: string` while the hydrated document type is `string & ObjectId`,
      // so a plain string array fails the strict condition type even though
      // Mongoose casts it at query time.
      .find({
        _id: {
          $in: branches.map((b) => b.uid) as unknown as UserDocument['_id'][],
        },
      })
      .select('firstName lastName')
      .exec();
    const ownerName = new Map(
      owners.map((o) => [
        String(o._id),
        `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim(),
      ]),
    );

    return branches.map((branch) => {
      const matchStrength =
        term.objectId === String(branch._id)
          ? MatchStrength.EXACT
          : strengthOfNameMatch(branch.branchName, term.name);
      const matchedOn = term.objectId ? MatchedOn.UID : MatchedOn.NAME;

      return {
        entityType: SearchEntityType.BRANCH,
        id: String(branch._id),
        title: branch.branchName,
        subtitle: ownerName.get(branch.uid) || undefined,
        matchedOn,
        matchStrength,
        context: {
          providerName: ownerName.get(branch.uid) || undefined,
          status: branch.isActive ? 'ACTIVE' : 'INACTIVE',
        },
        rank: rankOf(matchedOn, matchStrength),
      };
    });
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  private async searchOrders(term: TermShape): Promise<Ranked[]> {
    const clauses: Record<string, unknown>[] = [];

    if (term.orderNumber) clauses.push({ orderNumber: term.orderNumber });
    if (term.objectId) {
      clauses.push(
        { _id: term.objectId },
        { 'provider.branchId': term.objectId },
      );
    }
    if (term.firebaseUid) {
      clauses.push(
        { 'customer.uid': term.firebaseUid },
        { 'provider.providerUid': term.firebaseUid },
      );
    }
    if (term.phoneTail) {
      // The reason this whole query is server-side: an order snapshot stores
      // only a masked phone (0917•••4567), so the digits a customer reads out
      // can never match it. They are resolved against the USER record and
      // joined back here.
      const users = await this.userModel
        .find({ phoneNumber: { $regex: `${escapeTerm(term.phoneTail)}$` } })
        .select('_id')
        .limit(50)
        .exec();
      if (users.length === 0) return [];
      const uids = users.map((u) => String(u._id));
      clauses.push(
        { 'customer.uid': { $in: uids } },
        { 'provider.providerUid': { $in: uids } },
      );
    }
    if (clauses.length === 0) {
      const pattern = { $regex: escapeTerm(term.name), $options: 'i' };
      clauses.push(
        { 'customer.displayName': pattern },
        { 'provider.providerName': pattern },
      );
    }

    const orders = await this.orderModel
      .find({ $or: clauses })
      .sort({ createdAt: -1 })
      .limit(PER_TYPE_LIMIT)
      .exec();

    return orders.map((order) => {
      const matchedOn = term.orderNumber
        ? MatchedOn.ORDER_NUMBER
        : term.phoneTail
          ? MatchedOn.PHONE
          : term.objectId || term.firebaseUid
            ? MatchedOn.UID
            : MatchedOn.NAME;
      const matchStrength =
        matchedOn === MatchedOn.NAME
          ? strengthOfNameMatch(order.customer?.displayName, term.name)
          : MatchStrength.EXACT;

      return {
        entityType: SearchEntityType.ORDER,
        id: String(order._id),
        title: order.orderNumber ?? `Order ${String(order._id).slice(-6)}`,
        subtitle: [order.customer?.displayName, order.provider?.providerName]
          .filter(Boolean)
          .join(' → '),
        matchedOn,
        matchStrength,
        context: { status: order.status },
        rank: rankOf(matchedOn, matchStrength),
      };
    });
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  private async searchTickets(term: TermShape): Promise<Ranked[]> {
    const clauses: Record<string, unknown>[] = [];

    if (term.ticketNumber) clauses.push({ ticketNumber: term.ticketNumber });
    if (term.firebaseUid || term.objectId) {
      clauses.push({ 'requester.uid': term.firebaseUid ?? term.objectId });
    }
    if (term.email) clauses.push({ 'requester.email': term.email });
    if (clauses.length === 0) {
      const pattern = { $regex: escapeTerm(term.name), $options: 'i' };
      clauses.push({ subject: pattern }, { 'requester.displayName': pattern });
    }

    const tickets = await this.ticketModel
      .find({ $or: clauses })
      .sort({ createdAt: -1 })
      .limit(PER_TYPE_LIMIT)
      .exec();

    return tickets.map((ticket) => {
      const matchedOn = term.ticketNumber
        ? MatchedOn.TICKET_NUMBER
        : term.email
          ? MatchedOn.EMAIL
          : term.firebaseUid || term.objectId
            ? MatchedOn.UID
            : MatchedOn.NAME;
      const matchStrength =
        matchedOn === MatchedOn.NAME
          ? strengthOfNameMatch(ticket.subject, term.name)
          : MatchStrength.EXACT;

      return {
        entityType: SearchEntityType.TICKET,
        id: String(ticket._id),
        title: ticket.ticketNumber
          ? `${ticket.ticketNumber} — ${ticket.subject}`
          : ticket.subject,
        subtitle: ticket.requester?.displayName,
        matchedOn,
        matchStrength,
        context: {
          status: ticket.status,
          openTickets: TICKET_ACTIVE_STATUSES.includes(ticket.status) ? 1 : 0,
        },
        rank: rankOf(matchedOn, matchStrength),
      };
    });
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  /**
   * Which identifier actually matched this row.
   *
   * The database can only say THAT a document matched an $or, so this decides
   * from the document's own values — otherwise every result from a multi-clause
   * query would claim the first clause's identifier and ranking would be
   * decided by clause order rather than by what the operator typed.
   */
  private matchOf(
    term: TermShape,
    row: { email?: string; phone?: string; id: string; name: string },
  ): { matchedOn: MatchedOn; matchStrength: MatchStrength } {
    if (term.email && row.email?.toLowerCase() === term.email) {
      return { matchedOn: MatchedOn.EMAIL, matchStrength: MatchStrength.EXACT };
    }
    if (term.phoneTail && row.phone?.endsWith(term.phoneTail)) {
      return { matchedOn: MatchedOn.PHONE, matchStrength: MatchStrength.EXACT };
    }
    if (row.id === term.objectId || row.id === term.firebaseUid) {
      return { matchedOn: MatchedOn.UID, matchStrength: MatchStrength.EXACT };
    }
    return {
      matchedOn: MatchedOn.NAME,
      // row.name is the joined "first last", so a full-name search grades as
      // EXACT here even though no single stored field held the whole thing.
      matchStrength: strengthOfNameMatch(row.name, term.name),
    };
  }
}
