import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../users/schemas/user.schema';
import { Role, RoleDocument } from '../users/schemas/role.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  SupportTicket,
  SupportTicketDocument,
} from '../support-tickets/schemas/support-ticket.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { Device, DeviceDocument } from '../devices/schemas/device.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { FirebaseService } from '../firebase/firebase.service';
import { DirectoryFilterInput } from './dto/directory-filter.input';
import {
  DirectoryUser,
  DirectoryUserDetail,
  ImpersonationToken,
  LinkedAccount,
  PaginatedDirectoryUsers,
} from './models/directory-user.model';

/** Back-office roles. Impersonating one of these is refused — see `impersonate`. */
const BACK_OFFICE_ROLES = new Set(['admin', 'support']);

/**
 * The account directory — every person on the platform, in one place.
 *
 * Its own module rather than more methods on UsersService, because the useful
 * columns are not user fields: how many orders they placed, whether they hold
 * a wallet, which devices they registered. Those live in five other
 * collections, and pulling them into UsersService would make the module every
 * app's auth path depends on transitively aware of orders and tickets.
 *
 * Every model here is registered read-only via forFeature. Nothing in this
 * service writes: the actions an admin takes on an account (deactivate,
 * revoke sessions) already exist on UsersService, already require reasons, and
 * are already audited.
 *
 * The one exception is `impersonate`, which mints a credential rather than
 * writing to the database — it still belongs here rather than in its own
 * module, because it is a directory-user action in every sense that matters
 * to the caller.
 */
@Injectable()
export class DirectoryService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name)
    private readonly roleModel: Model<RoleDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(SupportTicket.name)
    private readonly ticketModel: Model<SupportTicketDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Device.name)
    private readonly deviceModel: Model<DeviceDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    private readonly firebaseService: FirebaseService,
  ) {}

  async list(
    filter: DirectoryFilterInput = {},
  ): Promise<PaginatedDirectoryUsers> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const query: Record<string, unknown> = {};
    if (filter.isActive !== undefined) query.isActive = filter.isActive;

    if (filter.roleIds?.length) {
      const roles = await this.roleModel
        .find({ roleId: { $in: filter.roleIds } })
        .select('_id')
        .exec();
      // An unknown roleId must match nothing rather than everything —
      // dropping the clause would silently widen the query to every account.
      query.role = { $in: roles.map((r) => r._id) };
    }

    const search = filter.search?.trim();
    if (search) {
      const clause = this.buildSearchClause(search);
      query.$or = clause;
    }

    const [rows, total] = await Promise.all([
      this.userModel
        .find(query)
        .populate('role')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.userModel.countDocuments(query).exec(),
    ]);

    const sharedCounts = await this.sharedPhoneCounts(
      rows.map((u) => u.phoneNumber).filter(Boolean),
    );

    let data = rows.map((user) => this.toDirectoryUser(user, sharedCounts));

    // Applied after mapping because the count is derived, not a stored field.
    // It narrows the current page rather than the whole query, which is why
    // the filter is documented as a triage aid and not a report.
    if (filter.sharedPhoneOnly) {
      data = data.filter((u) => u.sharedPhoneCount > 0);
    }

    return { data, total, limit, offset };
  }

  /**
   * One search box over four identifiers, matching the order search's
   * behaviour so support can paste the same string into either.
   */
  private buildSearchClause(term: string): Record<string, unknown>[] {
    const escaped = escapeRegex(term);
    const pattern = { $regex: escaped, $options: 'i' };

    const clause: Record<string, unknown>[] = [
      { firstName: pattern },
      { lastName: pattern },
      { email: pattern },
      // Exact, because a uid is an identifier and a substring match on one is
      // noise.
      { _id: term },
    ];

    // A FULL NAME has to be matched across both fields or it matches neither.
    // "PJ Tester" hits no single field on a user record, so the directory
    // returned nothing for the most natural thing an agent types — someone's
    // name as they just said it on the phone. The same gap existed in the
    // operational search and was fixed there first; this is its twin.
    const words = term.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      clause.push({
        $and: [
          { firstName: { $regex: `^${escapeRegex(words[0])}`, $options: 'i' } },
          {
            lastName: {
              $regex: `^${escapeRegex(words[words.length - 1])}`,
              $options: 'i',
            },
          },
        ],
      });
    }

    const digits = term.replace(/[^\d]/g, '');
    if (digits.length >= 7) {
      // Tail match, so every way of writing the same Philippine number finds
      // the same person.
      clause.push({
        phoneNumber: { $regex: `${escapeRegex(digits.slice(-10))}$` },
      });
    }
    return clause;
  }

  /**
   * How many OTHER accounts share each of the given phone numbers.
   *
   * One aggregation for the whole page rather than a query per row — this is
   * rendered as a column, so a per-row lookup would be 25 round trips to
   * decorate one screen.
   */
  private async sharedPhoneCounts(
    phones: (string | undefined)[],
  ): Promise<Map<string, number>> {
    const unique = [...new Set(phones.filter((p): p is string => !!p))];
    if (unique.length === 0) return new Map();

    const groups = await this.userModel
      .aggregate<{ _id: string; n: number }>([
        { $match: { phoneNumber: { $in: unique } } },
        { $group: { _id: '$phoneNumber', n: { $sum: 1 } } },
      ])
      .exec();

    // Minus one: an account always "shares" its own number with itself, and
    // reporting 1 for everybody would make the column useless.
    return new Map(groups.map((g) => [g._id, Math.max(0, g.n - 1)]));
  }

  private toDirectoryUser(
    user: UserDocument,
    sharedCounts: Map<string, number>,
  ): DirectoryUser {
    const role = user.role as unknown as Role | undefined;
    return {
      uid: String(user._id),
      displayName:
        `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
        user.email ||
        String(user._id),
      email: user.email,
      phoneNumber: user.phoneNumber,
      roleId: role?.roleId ?? 'unknown',
      roleName: role?.roleName ?? 'Unknown',
      isActive: user.isActive,
      accountStatus: user.accountStatus ?? undefined,
      washerStatus: user.washerStatus ?? undefined,
      selfieStatus: user.selfieStatus ?? undefined,
      sharedPhoneCount: user.phoneNumber
        ? (sharedCounts.get(user.phoneNumber) ?? 0)
        : 0,
      createdAt: (user as unknown as { createdAt?: Date }).createdAt,
    };
  }

  async detail(uid: string): Promise<DirectoryUserDetail> {
    const user = await this.userModel.findById(uid).populate('role').exec();
    if (!user) throw new NotFoundException('Account not found');

    const sharedCounts = await this.sharedPhoneCounts([user.phoneNumber]);
    const directoryUser = this.toDirectoryUser(user, sharedCounts);

    // Which branchIds this account fulfils through — a washer's anchor branch
    // or a merchant's branches. Needed for both the provider order count and
    // the wallet, and resolved once for both.
    const branchIds = await this.providerBranchIds(uid);

    const [
      ordersAsCustomer,
      ordersAsProvider,
      ticketsRaised,
      lastOrder,
      wallet,
      devices,
      linkedAccounts,
    ] = await Promise.all([
      this.orderModel.countDocuments({ 'customer.uid': uid }).exec(),
      branchIds.length
        ? this.orderModel
            .countDocuments({ 'provider.branchId': { $in: branchIds } })
            .exec()
        : Promise.resolve(0),
      this.ticketModel.countDocuments({ 'requester.uid': uid }).exec(),
      this.orderModel
        .findOne({ 'customer.uid': uid })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .exec(),
      branchIds.length
        ? this.walletModel.findOne({ branchId: { $in: branchIds } }).exec()
        : Promise.resolve(null),
      this.deviceModel
        .find({ $or: [{ uid }, { staffUid: uid }] })
        .sort({ createdAt: -1 })
        .exec(),
      this.linkedAccounts(uid, user.phoneNumber),
    ]);

    return {
      user: directoryUser,
      ordersAsCustomer,
      ordersAsProvider,
      ticketsRaised,
      lastOrderAt:
        (lastOrder as unknown as { createdAt?: Date } | null)?.createdAt ??
        undefined,
      // Null, not zero: an account with no wallet is a different fact from a
      // provider whose wallet is empty.
      walletBalanceCentavos: wallet ? wallet.balanceCentavos : undefined,
      devices: devices.map((d) => ({
        deviceId: String(d._id),
        deviceName: d.deviceName,
        operatingSystem: d.operatingSystem,
        deviceModel: d.deviceModel,
        status: d.status,
        staffName: d.staffName,
        createdAt: (d as unknown as { createdAt?: Date }).createdAt,
      })),
      linkedAccounts,
      sessionsValidAfter: user.sessionsValidAfter ?? undefined,
    };
  }

  /**
   * Mint a credential letting an admin sign in as this account.
   *
   * Two refusals that exist purely for security, not usability:
   *
   *  - Never against a back-office account. There is no legitimate support
   *    reason to sign in as another admin, and allowing it would turn a
   *    single compromised admin session into a way to mint credentials for
   *    every other admin on the platform — the one privilege-escalation path
   *    this whole panel exists to prevent.
   *  - Never against yourself. Pointless, and a caller doing it by accident
   *    is a sign something upstream passed the wrong uid.
   *
   * The resolver, not this method, writes the audit record — same split as
   * every other action in the panel — but this being the single most
   * sensitive mutation here, callers should treat "the audit write failed"
   * as a reason to treat the whole request as failed, unlike elsewhere.
   */
  async impersonate(
    targetUid: string,
    actorUid: string,
  ): Promise<ImpersonationToken> {
    if (targetUid === actorUid) {
      throw new BadRequestException('Cannot impersonate your own account');
    }

    const target = await this.userModel
      .findById(targetUid)
      .populate('role')
      .exec();
    if (!target) throw new NotFoundException('Account not found');

    const roleId = (target.role as unknown as Role | undefined)?.roleId;
    if (!roleId || BACK_OFFICE_ROLES.has(roleId)) {
      throw new ForbiddenException(
        'Back-office accounts cannot be impersonated',
      );
    }

    // A deactivated account cannot actually be signed into: GqlAuthGuard
    // checks isActive before anything else runs, so a token minted here would
    // fail on the very first request the client made with it. Refusing here
    // is a real check, not belt-and-braces — the credential this method
    // hands back would otherwise be dead on arrival.
    if (!target.isActive) {
      throw new BadRequestException(
        'This account is deactivated and cannot be signed into',
      );
    }

    // Claims land on the ID token the client mints from this, so a client
    // that chooses to read them can show "you are viewing as X" — nothing in
    // the panel enforces that today, but the data is there for when a client
    // does.
    const customToken = await this.firebaseService
      .getAuth()
      .createCustomToken(targetUid, { impersonation: true, actorUid });

    return {
      customToken,
      targetUid,
      targetName:
        `${target.firstName ?? ''} ${target.lastName ?? ''}`.trim() ||
        target.email,
      targetRoleId: roleId,
    };
  }

  /** The branchIds this account fulfils orders through, if any. */
  private async providerBranchIds(uid: string): Promise<string[]> {
    const [washer, branches] = await Promise.all([
      this.washerModel.findOne({ uid }).select('branchId').exec(),
      this.branchModel.find({ uid }).select('_id').exec(),
    ]);
    const ids = branches.map((b) => String(b._id));
    if (washer?.branchId) ids.push(washer.branchId);
    return [...new Set(ids)];
  }

  /**
   * Other accounts sharing this one's phone number.
   *
   * Capped, because a shared office number could otherwise return hundreds of
   * rows and the panel only needs enough to tell a human that something is
   * worth looking at.
   */
  private async linkedAccounts(
    uid: string,
    phoneNumber?: string,
  ): Promise<LinkedAccount[]> {
    if (!phoneNumber) return [];

    const others = await this.userModel
      // Cast: User._id is a Firebase uid stored as a String, but the hydrated
      // document type intersects it with ObjectId, so a plain string fails the
      // strict condition type. Same mismatch the order search works around.
      .find({
        phoneNumber,
        _id: { $ne: uid as unknown as UserDocument['_id'] },
      })
      .populate('role')
      .limit(20)
      .exec();

    return others.map((other) => ({
      uid: String(other._id),
      displayName:
        `${other.firstName ?? ''} ${other.lastName ?? ''}`.trim() ||
        other.email,
      roleId: (other.role as unknown as Role | undefined)?.roleId ?? 'unknown',
      isActive: other.isActive,
      matchedOn: 'PHONE',
      createdAt: (other as unknown as { createdAt?: Date }).createdAt,
    }));
  }
}

// Search terms go into a RegExp — escape them so a stray "(" is a literal
// rather than a syntax error, and a ".*" cannot force a collection scan.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
