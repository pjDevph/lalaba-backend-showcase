import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import {
  AccountStatus,
  User,
  UserDocument,
} from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import { OrderStatus } from '../online-orders/schemas/order-status.enum';
import {
  PosOrder,
  PosOrderDocument,
  LaundryStatus,
} from '../pos_orders/schemas/pos-order.schema';
import {
  WasherBooking,
  WasherBookingDocument,
  BookingStatus,
} from '../washer/schemas/washer-booking.schema';
import { Device, DeviceDocument } from '../devices/schemas/device.schema';
import { CourierVerificationService } from '../courier-verification/courier-verification.service';
import {
  ActivityLog,
  ActivityLogDocument,
} from '../activity-logs/schemas/activity-log.schema';
import {
  AccountDeletionRecord,
  AccountDeletionRecordDocument,
} from './schemas/account-deletion-record.schema';
import { FirebaseService } from '../firebase/firebase.service';
import { DeletionBlocker } from './models/deletion-blocker.model';
import { DeletionQueueEntry } from './models/deletion-queue-entry.model';

// An online order stops blocking deactivation only once it can no longer
// move — everything else still involves live custody, money, or a courier.
const TERMINAL_ORDER_STATUSES = [
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED_BY_PROVIDER,
  OrderStatus.COMPLETED,
  OrderStatus.REFUNDED,
];

export const BLOCKER_ACTIVE_ONLINE_ORDERS = 'ACTIVE_ONLINE_ORDERS';
export const BLOCKER_WALLET_BALANCE_REMAINING = 'WALLET_BALANCE_REMAINING';
export const BLOCKER_ACTIVE_STAFF_EXISTS = 'ACTIVE_STAFF_EXISTS';
export const BLOCKER_UNRESOLVED_POS_ORDERS = 'UNRESOLVED_POS_ORDERS';
export const BLOCKER_ACTIVE_WASHER_BOOKINGS = 'ACTIVE_WASHER_BOOKINGS';

// Grace period between requestAccountDeletion and irreversible PII erasure.
// The account is locked out for the whole window but can cancel at any point
// inside it.
export const DELETION_GRACE_DAYS = 30;

// A POS order is "unresolved" while laundry is still on the premises. CLAIMED
// (picked up) and COMPLETED (product-only sale) are terminal, same as
// CANCELLED/VOID.
const UNRESOLVED_POS_LAUNDRY_STATUSES = [
  LaundryStatus.PENDING,
  LaundryStatus.IN_PROGRESS,
  LaundryStatus.READY,
];

// Legacy washer_bookings (GAP-P0-011: read-only in Phase 2) still represent
// real custody if any survived, so they block erasure.
const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.IN_PROGRESS,
];

// Placeholder identity written over every PII field at erasure time.
export const ANONYMIZED_FIRST_NAME = 'Deleted';
export const ANONYMIZED_LAST_NAME = 'User';
export const ANONYMIZED_DISPLAY_NAME = 'Deleted User';
export const anonymizedEmail = (uid: string): string =>
  `deleted_${uid}@deleted.lalaba.internal`;

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerProfileModel: Model<WasherProfileDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly onlineOrderModel: Model<OnlineOrderDocument>,
    @InjectModel(PosOrder.name)
    private readonly posOrderModel: Model<PosOrderDocument>,
    @InjectModel(WasherBooking.name)
    private readonly washerBookingModel: Model<WasherBookingDocument>,
    @InjectModel(Device.name)
    private readonly deviceModel: Model<DeviceDocument>,
    @InjectModel(ActivityLog.name)
    private readonly activityLogModel: Model<ActivityLogDocument>,
    @InjectModel(AccountDeletionRecord.name)
    private readonly recordModel: Model<AccountDeletionRecordDocument>,
    private readonly firebaseService: FirebaseService,
    private readonly courierVerificationService: CourierVerificationService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** All branchIds a user provides service through (merchant branches, or a
   * washer's anchor branch). Empty for customers. */
  private async providerBranchIds(
    user: User,
    roleId?: string,
  ): Promise<string[]> {
    if (roleId === 'merchant') {
      const branches = await this.branchModel
        .find({ uid: user._id })
        .select('_id')
        .exec();
      return branches.map((b) => String(b._id));
    }
    if (roleId === 'washer') {
      const profile = await this.washerProfileModel
        .findOne({ uid: user._id })
        .select('branchId')
        .exec();
      return profile ? [profile.branchId] : [];
    }
    return [];
  }

  /**
   * Admin/support queue view — every account currently mid-deletion, plus
   * recent cancellations and completions for audit context. Bounded to the
   * 500 most relevant rows per status; this is an operational queue, not an
   * export, and a queue with more than a handful of pending rows at once
   * would itself be the story worth investigating.
   */
  async listDeletionQueue(
    status?: 'pending' | 'cancelled' | 'completed',
  ): Promise<DeletionQueueEntry[]> {
    const match: Record<string, unknown> = {};
    if (status === 'pending') {
      match.completedAt = null;
      match.cancelledAt = null;
    } else if (status === 'cancelled') {
      match.cancelledAt = { $ne: null };
    } else if (status === 'completed') {
      match.completedAt = { $ne: null };
    }

    const records = await this.recordModel
      .find(match)
      .sort({ scheduledAt: status === 'pending' ? 1 : -1 })
      .limit(500)
      .exec();
    if (!records.length) return [];

    const users = await this.userModel
      .find({ _id: { $in: records.map((r) => r.uid) } } as any)
      .select('firstName lastName email')
      .exec();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    return records.map((r) => {
      const user = userMap.get(r.uid);
      return {
        uid: r.uid,
        roleId: r.roleId,
        displayName: user
          ? `${user.firstName} ${user.lastName}`.trim()
          : 'Unknown',
        email: user?.email ?? 'unknown',
        requestedAt: r.requestedAt,
        scheduledAt: r.scheduledAt,
        cancelledAt: r.cancelledAt ?? undefined,
        cancelledBy: r.cancelledBy ?? undefined,
        completedAt: r.completedAt ?? undefined,
      };
    });
  }

  async listBlockers(uid: string): Promise<DeletionBlocker[]> {
    const user = await this.userModel.findById(uid).populate('role').exec();
    if (!user) throw new NotFoundException('User not found');
    const roleId = (user.role as unknown as Role)?.roleId;

    const blockers: DeletionBlocker[] = [];
    const branchIds = await this.providerBranchIds(user, roleId);

    // 1. Active online orders — as provider (their branches) or customer.
    const orderFilter =
      branchIds.length > 0
        ? {
            'provider.branchId': { $in: branchIds },
            status: { $nin: TERMINAL_ORDER_STATUSES },
          }
        : {
            'customer.uid': uid,
            status: { $nin: TERMINAL_ORDER_STATUSES },
          };
    const activeOrders = await this.onlineOrderModel
      .find(orderFilter)
      .select('_id')
      .exec();
    if (activeOrders.length > 0) {
      blockers.push({
        code: BLOCKER_ACTIVE_ONLINE_ORDERS,
        message: `${activeOrders.length} active order${
          activeOrders.length === 1 ? '' : 's'
        } — complete or cancel ${
          activeOrders.length === 1 ? 'it' : 'them'
        } before deactivating your account.`,
        count: activeOrders.length,
        ids: activeOrders.map((o) => String(o._id)),
      });
    }

    // 2. Non-zero wallet balance on any of the user's branches. The wallet
    // is prepaid/consumable with no withdrawal path, so a remaining balance
    // must be spent down (or resolved with support) first.
    if (branchIds.length > 0) {
      const funded = await this.walletModel
        .find({ branchId: { $in: branchIds }, balanceCentavos: { $ne: 0 } })
        .select('_id balanceCentavos')
        .exec();
      if (funded.length > 0) {
        const totalCentavos = funded.reduce(
          (sum, w) => sum + w.balanceCentavos,
          0,
        );
        blockers.push({
          code: BLOCKER_WALLET_BALANCE_REMAINING,
          message: `Your wallet still holds ₱${(totalCentavos / 100).toFixed(
            2,
          )} — use the balance or contact support before deactivating your account.`,
          count: funded.length,
          ids: funded.map((w) => String(w._id)),
        });
      }
    }

    // 3. Active staff accounts (merchant only) — they would be orphaned.
    if (roleId === 'merchant') {
      const staff = await this.userModel
        .find({ merchantId: uid, isActive: true, isArchived: { $ne: true } })
        .select('_id')
        .exec();
      if (staff.length > 0) {
        blockers.push({
          code: BLOCKER_ACTIVE_STAFF_EXISTS,
          message: `${staff.length} active staff account${
            staff.length === 1 ? '' : 's'
          } — archive ${
            staff.length === 1 ? 'it' : 'them'
          } before deactivating your account.`,
          count: staff.length,
          ids: staff.map((s) => String(s._id)),
        });
      }
    }

    // 4. Unresolved POS (walk-in) orders on any of the merchant's branches —
    // laundry physically on the premises must not be orphaned.
    if (branchIds.length > 0) {
      const posOrders = await this.posOrderModel
        .find({
          branchId: { $in: branchIds },
          laundryStatus: { $in: UNRESOLVED_POS_LAUNDRY_STATUSES },
        })
        .select('_id')
        .exec();
      if (posOrders.length > 0) {
        blockers.push({
          code: BLOCKER_UNRESOLVED_POS_ORDERS,
          message: `${posOrders.length} unresolved walk-in order${
            posOrders.length === 1 ? '' : 's'
          } — complete, claim, cancel, or void ${
            posOrders.length === 1 ? 'it' : 'them'
          } before deleting your account.`,
          count: posOrders.length,
          ids: posOrders.map((o) => String(o._id)),
        });
      }
    }

    // 5. Legacy washer bookings still in flight (GAP-P0-011 preserved
    // collection). Normally empty in Phase 2, but a surviving row means real
    // custody.
    const bookings = await this.washerBookingModel
      .find({
        $or: [{ washerId: uid }, { customerId: uid }],
        status: { $in: ACTIVE_BOOKING_STATUSES },
      })
      .select('_id')
      .exec();
    if (bookings.length > 0) {
      blockers.push({
        code: BLOCKER_ACTIVE_WASHER_BOOKINGS,
        message: `${bookings.length} active booking${
          bookings.length === 1 ? '' : 's'
        } — complete or cancel ${
          bookings.length === 1 ? 'it' : 'them'
        } before deleting your account.`,
        count: bookings.length,
        ids: bookings.map((b) => String(b._id)),
      });
    }

    return blockers;
  }

  // ------------------------------------------------------------------
  // Lifecycle: request → (grace period) → erase, cancellable throughout
  // ------------------------------------------------------------------

  /**
   * Self-service deletion request. Locks the account out immediately
   * (isActive=false, accountStatus=DELETION_PENDING) and schedules irreversible
   * PII erasure for DELETION_GRACE_DAYS later. Nothing is erased here — the
   * whole point of the grace period is that the user can still change their
   * mind via cancelDeletion.
   */
  async requestDeletion(uid: string): Promise<User> {
    const existing = await this.userModel.findById(uid).populate('role').exec();
    if (!existing) throw new NotFoundException('User not found');
    if (existing.accountStatus === AccountStatus.DELETED) {
      throw new BadRequestException('This account has already been deleted.');
    }
    if (existing.accountStatus === AccountStatus.DELETION_PENDING) {
      throw new BadRequestException(
        'This account already has a pending deletion request.',
      );
    }

    const blockers = await this.listBlockers(uid);
    if (blockers.length > 0) {
      throw new BadRequestException(
        `Account cannot be deleted yet: ${blockers
          .map((b) => b.message)
          .join(' ')}`,
      );
    }

    const now = new Date();
    const scheduledAt = new Date(
      now.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );

    const user = await this.userModel
      .findByIdAndUpdate(
        uid,
        {
          $set: {
            isActive: false,
            accountStatus: AccountStatus.DELETION_PENDING,
            deletionRequestedAt: now,
            deletionScheduledAt: scheduledAt,
            deletionCancelledAt: null,
          },
        },
        { new: true },
      )
      .exec();
    if (!user) throw new NotFoundException('User not found');

    // GqlAuthGuard serves users from cache — drop it so the lockout takes
    // effect on the very next request.
    await this.cache.del(`user:${uid}`);

    await this.recordModel.create({
      uid,
      roleId: (existing.role as unknown as Role)?.roleId ?? null,
      requestedAt: now,
      scheduledAt,
    });

    this.logger.log(
      `Account deletion requested: ${uid} — erasure scheduled for ${scheduledAt.toISOString()}`,
    );
    return user;
  }

  /**
   * Cancels a pending deletion and restores access. Reachable by the account
   * owner during the grace period (the auth guard lets a DELETION_PENDING user
   * through to this one operation) and by admin/support on their behalf.
   * Impossible after erasure — DELETED is terminal.
   */
  async cancelDeletion(uid: string, cancelledBy: string): Promise<User> {
    const existing = await this.userModel.findById(uid).exec();
    if (!existing) throw new NotFoundException('User not found');
    if (existing.accountStatus !== AccountStatus.DELETION_PENDING) {
      throw new BadRequestException(
        'This account does not have a pending deletion request.',
      );
    }

    const now = new Date();
    const user = await this.userModel
      .findByIdAndUpdate(
        uid,
        {
          $set: {
            isActive: true,
            accountStatus: AccountStatus.ACTIVE,
            deletionCancelledAt: now,
            deletionRequestedAt: null,
            deletionScheduledAt: null,
          },
        },
        { new: true },
      )
      .exec();
    await this.cache.del(`user:${uid}`);

    await this.recordModel
      .updateMany(
        { uid, completedAt: null, cancelledAt: null },
        { $set: { cancelledAt: now, cancelledBy } },
      )
      .exec();

    this.logger.log(`Account deletion cancelled: ${uid} (by ${cancelledBy})`);
    return user!;
  }

  /**
   * Grace-period sweep: erases every account whose scheduled date has passed.
   * Driven by AccountDeletionScheduler (nightly) and by the admin
   * runScheduledAccountDeletions mutation. Per-account failures are isolated so
   * one bad row cannot stall the batch; the record stays open and the next
   * sweep retries it.
   */
  async processScheduledDeletions(now: Date = new Date()): Promise<{
    processed: number;
    failed: number;
  }> {
    const due = await this.userModel
      .find({
        accountStatus: AccountStatus.DELETION_PENDING,
        deletionScheduledAt: { $lte: now },
      })
      .exec();

    let processed = 0;
    let failed = 0;
    for (const user of due) {
      try {
        await this.eraseAccount(user, now);
        processed++;
      } catch (error) {
        failed++;
        this.logger.error(
          `Failed to erase account ${user._id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { processed, failed };
  }

  /**
   * Irreversible PII erasure.
   *
   * ERASED (overwritten in place / deleted):
   *   - User: firstName, lastName, email, phoneNumber, homeAddress, fcmTokens
   *   - Firebase Auth identity (a merely-disabled record still holds
   *     email/phone/displayName — that is the retention liability)
   *   - Registered devices for the uid
   *   - WasherProfile: displayName, storeName, phone, photoUrl, bio,
   *     description, logo/cover images, address, mapLocation, certification
   *     evidence pointers
   *   - Denormalized PII copies: ActivityLog actorName/actorEmail,
   *     OnlineOrder.customer snapshot (name/phone/address/coords),
   *     legacy WasherBooking customerName/customerPhone
   *
   * RETAINED (required for accounting/audit; linkage anonymized, not broken):
   *   - The User document itself, keyed by the same _id, so every foreign key
   *     still resolves — to "Deleted User"
   *   - Wallets, wallet ledger/transactions, POS orders and transactions,
   *     online orders (amounts, statuses, timestamps, uids)
   *   - KYC documents and the KYC audit trail
   *   - account_deletion_records (proof of what ran, and when)
   */
  private async eraseAccount(user: UserDocument, now: Date): Promise<void> {
    const uid = user._id;

    await this.userModel
      .findByIdAndUpdate(uid, {
        $set: {
          accountStatus: AccountStatus.DELETED,
          isActive: false,
          deletedAt: now,
          anonymizedAt: now,
          firstName: ANONYMIZED_FIRST_NAME,
          lastName: ANONYMIZED_LAST_NAME,
          email: anonymizedEmail(uid),
          phoneNumber: '',
          homeAddress: {},
          fcmTokens: [],
          photoUrl: null,
          selfieStatus: null,
          selfieVerifiedAt: null,
          selfieRevokedReason: null,
        },
      })
      .exec();
    await this.cache.del(`user:${uid}`);

    // Courier selfies: the stored objects go too, not just the pointers. This is
    // the one asset class where nulling the field is not enough — the image sits
    // in a PUBLIC bucket at a permanent URL, and it is a photograph of the
    // person's face. No-op for every non-courier account.
    await this.courierVerificationService.eraseForUser(uid);

    const devices = await this.deviceModel.deleteMany({ uid }).exec();

    let firebaseIdentityDeleted = false;
    try {
      await this.firebaseService.getAuth().deleteUser(uid);
      firebaseIdentityDeleted = true;
    } catch (error) {
      // Already gone is success; anything else is logged and reported in the
      // record so an operator can finish the job by hand.
      if ((error as { code?: string })?.code === 'auth/user-not-found') {
        firebaseIdentityDeleted = true;
      } else {
        this.logger.warn(
          `Could not delete Firebase identity for ${uid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const washerProfile = await this.washerProfileModel
      .updateOne(
        { uid },
        {
          $set: {
            displayName: ANONYMIZED_DISPLAY_NAME,
            // Free text she wrote herself, and in practice usually built from
            // her own name ("Maria's Laundry") — erased with the rest of it.
            storeName: null,
            phone: null,
            photoUrl: null,
            bio: null,
            description: null,
            logoUrl: null,
            coverPhotoUrl: null,
            address: null,
            mapLocation: null,
            certProofUrls: [],
            legacyCertProofUrls: [],
            certProofObjectKeys: [],
            isAvailable: false,
          },
        },
      )
      .exec();

    const activityLogs = await this.activityLogModel
      .updateMany(
        { actorId: uid },
        {
          $set: {
            actorName: ANONYMIZED_DISPLAY_NAME,
            actorEmail: anonymizedEmail(uid),
          },
        },
      )
      .exec();

    // Financial history stays; only the person-identifying half of the
    // denormalized customer snapshot is overwritten. customer.uid is kept so
    // the order still links to the (now anonymous) account.
    const orders = await this.onlineOrderModel
      .updateMany(
        { 'customer.uid': uid },
        {
          $set: {
            'customer.displayName': ANONYMIZED_DISPLAY_NAME,
            'customer.maskedPhone': null,
            'customer.address': null,
            'customer.mapLocation': null,
            'customer.areaLabel': null,
          },
        },
      )
      .exec();

    const bookings = await this.washerBookingModel
      .updateMany(
        { customerId: uid },
        {
          $set: {
            customerName: ANONYMIZED_DISPLAY_NAME,
            customerPhone: null,
          },
        },
      )
      .exec();

    await this.recordModel
      .updateMany(
        { uid, completedAt: null, cancelledAt: null },
        {
          $set: {
            completedAt: now,
            processingSummary: {
              userAnonymized: true,
              devicesRemoved: devices.deletedCount ?? 0,
              firebaseIdentityDeleted,
              washerProfileScrubbed: (washerProfile.matchedCount ?? 0) > 0,
              activityLogsRedacted: activityLogs.matchedCount ?? 0,
              onlineOrderSnapshotsRedacted: orders.matchedCount ?? 0,
              legacyBookingContactRedacted: bookings.matchedCount ?? 0,
            },
          },
        },
      )
      .exec();

    this.logger.log(`Account PII erased after grace period: ${uid}`);
  }
}
