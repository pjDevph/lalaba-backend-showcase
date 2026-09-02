import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  Permission,
  PermissionDocument,
} from '../permissions/schemas/permission.schema';
import { grantsForBranch } from '../users/branch-access.util';
import { resolveGrantedPermissionNames } from '../permissions/resolve-permission-names';
import {
  Notification,
  NotificationDocument,
  NOTIFICATION_RETENTION_DAYS,
} from './schemas/notification.schema';
import {
  NotificationRead,
  NotificationReadDocument,
} from './schemas/notification-read.schema';
import {
  NotificationReadCursor,
  NotificationReadCursorDocument,
} from './schemas/notification-read-cursor.schema';
import {
  NotificationAudience,
  NotificationCategory,
  NotificationType,
} from './notification.enums';
import {
  NotificationItem,
  PaginatedNotifications,
} from './models/notification-item.model';
import { NotificationFilterInput } from './dto/notification-filter.input';

/**
 * A mongo query predicate. Mongoose 9 no longer exports FilterQuery, and no
 * other service here types its filters at all, so this stays deliberately
 * loose rather than inventing a stricter convention for one module.
 */
type NotificationFilter = Record<string, unknown>;

/** Badge cap. Counting past this buys nothing — the UI renders "99+". */
export const UNREAD_COUNT_CAP = 99;

/** What a caller may see, resolved once per request. */
export interface FeedScope {
  uid: string;
  branchIds: string[];
  granted: Set<string>;
}

export interface PersistNotificationInput {
  audience: NotificationAudience;
  uid?: string | null;
  branchId?: string | null;
  merchantId?: string | null;
  requiredPermission?: string | null;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, string | null | undefined>;
  deepLink?: string | null;
  sourceEventId?: string | null;
}

/**
 * The read side of the notification feed, plus the single write used by
 * NotificationsService.notify().
 *
 * Split out of notifications.service.ts so the push transport stays a small
 * file with one job. Everything about visibility, read state and paging lives
 * here.
 */
@Injectable()
export class NotificationsFeedService {
  private readonly logger = new Logger('NotificationsFeed');

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(NotificationRead.name)
    private readonly readModel: Model<NotificationReadDocument>,
    @InjectModel(NotificationReadCursor.name)
    private readonly cursorModel: Model<NotificationReadCursorDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Permission.name)
    private readonly permissionModel: Model<PermissionDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  private roleIdOf(user: User): string {
    return (user.role as unknown as Role)?.roleId ?? '';
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Persist one feed row.
   *
   * Returns null when `sourceEventId` collides with an existing row — the event
   * has already been reported and this is a retry. Callers use that null to
   * skip the push too, which is what makes the order sweeper safe to re-run.
   */
  async persist(
    input: PersistNotificationInput,
  ): Promise<NotificationDocument | null> {
    const expiresAt = new Date(
      Date.now() + NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      return await this.notificationModel.create({
        ...input,
        // Strip undefined so absent keys don't overwrite the schema defaults.
        data: Object.fromEntries(
          Object.entries(input.data ?? {}).filter(([, v]) => v != null),
        ),
        expiresAt,
      });
    } catch (err) {
      if (this.isDuplicateKey(err)) {
        this.logger.log(
          `duplicate sourceEventId ${input.sourceEventId} — already reported, skipping`,
        );
        return null;
      }
      throw err;
    }
  }

  private isDuplicateKey(err: unknown): boolean {
    return (err as { code?: number })?.code === 11000;
  }

  /** Stamp a row as pushed. Best-effort observability, never load-bearing. */
  async markPushed(notificationId: string): Promise<void> {
    await this.notificationModel
      .updateOne({ _id: notificationId } as NotificationFilter, {
        $set: { pushSentAt: new Date() },
      })
      .exec();
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  /**
   * Which branches this account can see notifications for.
   *
   * Merchants and washers own their branches (Branch.uid is the owner's uid);
   * staff carry an explicit branchIds list. Customers and couriers have none —
   * they only ever receive direct rows.
   *
   * Mirrors the ownership rules in OnlineOrdersService.assertBranchOwnership
   * and TasksResolver, which resolve the same question the same way.
   */
  async visibleBranchIds(user: User): Promise<string[]> {
    const roleId = this.roleIdOf(user);
    if (roleId === 'merchant' || roleId === 'washer') {
      const branches = await this.branchModel
        .find({ uid: user._id })
        .select('_id')
        .lean()
        .exec();
      return branches.map((b) => String(b._id));
    }
    if (roleId === 'staff') return (user.branchIds ?? []).map(String);
    return [];
  }

  async scopeFor(
    user: User,
    activeBranchId?: string | null,
  ): Promise<FeedScope> {
    const roleId = this.roleIdOf(user);

    // Staff see the feed for the branch they are working, filtered by the
    // grants they hold THERE. Passing the account-global union would surface a
    // BGC row to someone who only holds the permission in Makati.
    if (roleId === 'staff') {
      const branchIds = activeBranchId
        ? (user.branchIds ?? []).map(String).includes(String(activeBranchId))
          ? [String(activeBranchId)]
          : []
        : [];
      const granted = await resolveGrantedPermissionNames(
        roleId,
        grantsForBranch(user.branchAccess, activeBranchId),
        this.permissionModel,
      );
      return { uid: user._id, branchIds, granted };
    }

    const [branchIds, granted] = await Promise.all([
      this.visibleBranchIds(user),
      resolveGrantedPermissionNames(
        roleId,
        user.permissionIds,
        this.permissionModel,
      ),
    ]);
    return { uid: user._id, branchIds, granted };
  }

  /**
   * The one predicate that defines "notifications this account may see".
   *
   * Used by the feed page, the unread count AND the read mutations — a
   * mutation that skipped it would be an IDOR, since marking a row read
   * confirms the row exists.
   */
  private visibilityFilter(scope: FeedScope): NotificationFilter {
    const clauses: NotificationFilter[] = [
      { audience: NotificationAudience.USER, uid: scope.uid },
    ];
    if (scope.branchIds.length) {
      clauses.push({
        audience: NotificationAudience.BRANCH,
        branchId: { $in: scope.branchIds },
        // null = everyone on the branch; otherwise the account must hold it.
        $or: [
          { requiredPermission: null },
          { requiredPermission: { $in: [...scope.granted] } },
        ],
      });
    }
    return { $or: clauses, expiresAt: { $gt: new Date() } };
  }

  // ---------------------------------------------------------------------------
  // Read state
  // ---------------------------------------------------------------------------

  private async readAllBefore(uid: string): Promise<Date | null> {
    const cursor = await this.cursorModel.findOne({ uid }).lean().exec();
    return cursor?.readAllBefore ?? null;
  }

  /**
   * Resolve isRead for a page of rows in two queries rather than one per row.
   *
   * A direct row carries its own readAt. A branch row is read when this account
   * has a NotificationRead for it, or when the whole page predates their
   * "mark all read" watermark.
   */
  private async resolveReadState(
    uid: string,
    rows: NotificationDocument[],
  ): Promise<Map<string, boolean>> {
    const watermark = await this.readAllBefore(uid);
    const branchRowIds = rows
      .filter((r) => r.audience === NotificationAudience.BRANCH)
      .map((r) => String(r._id));

    const readIds = new Set<string>();
    if (branchRowIds.length) {
      const reads = await this.readModel
        .find({ uid, notificationId: { $in: branchRowIds } })
        .select('notificationId')
        .lean()
        .exec();
      for (const r of reads) readIds.add(String(r.notificationId));
    }

    const state = new Map<string, boolean>();
    for (const row of rows) {
      const id = String(row._id);
      const underWatermark = watermark != null && row.createdAt <= watermark;
      state.set(
        id,
        row.audience === NotificationAudience.USER
          ? row.readAt != null || underWatermark
          : underWatermark || readIds.has(id),
      );
    }
    return state;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async myNotifications(
    user: User,
    limit: number,
    offset: number,
    filter?: NotificationFilterInput,
    activeBranchId?: string | null,
  ): Promise<PaginatedNotifications> {
    const scope = await this.scopeFor(user, activeBranchId);
    const base = this.visibilityFilter(scope);
    const query: NotificationFilter = { ...base };
    if (filter?.categories?.length) {
      query.category = { $in: filter.categories };
    }

    const [rows, total] = await Promise.all([
      this.notificationModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.notificationModel.countDocuments(query).exec(),
    ]);

    const readState = await this.resolveReadState(user._id, rows);
    let data = rows.map((row) => this.toItem(row, readState));

    // unreadOnly filters the PAGE, not the query: read state is computed from
    // two other collections and cannot be expressed in the same find(). The
    // page therefore stays the requested size or smaller, and `total` remains
    // the unfiltered count. Callers wanting an exact unread total have
    // myUnreadNotificationCount.
    if (filter?.unreadOnly) data = data.filter((i) => !i.isRead);

    return { data, total, limit, offset };
  }

  private toItem(
    row: NotificationDocument,
    readState: Map<string, boolean>,
  ): NotificationItem {
    const id = String(row._id);
    return {
      id,
      type: row.type,
      category: row.category,
      title: row.title,
      body: row.body,
      data: row.data ?? {},
      deepLink: row.deepLink ?? null,
      branchId: row.branchId ?? null,
      requiredPermission: row.requiredPermission ?? null,
      isRead: readState.get(id) ?? false,
      createdAt: row.createdAt,
    };
  }

  /**
   * Unread count for the badge, capped at UNREAD_COUNT_CAP.
   *
   * The cap is what keeps this cheap: the aggregation stops as soon as it has
   * enough to render "99+", so an account that has ignored their feed for a
   * year costs the same as one with a handful of rows.
   */
  async myUnreadNotificationCount(
    user: User,
    activeBranchId?: string | null,
  ): Promise<number> {
    const scope = await this.scopeFor(user, activeBranchId);
    const watermark = await this.readAllBefore(user._id);

    const match: NotificationFilter = {
      ...this.visibilityFilter(scope),
      // Direct rows carry their own read state; branch rows are resolved by
      // the $lookup below.
      $and: [
        {
          $or: [
            { audience: NotificationAudience.BRANCH },
            { audience: NotificationAudience.USER, readAt: null },
          ],
        },
      ],
    };
    if (watermark) {
      (match.$and as NotificationFilter[]).push({
        createdAt: { $gt: watermark },
      });
    }

    const result = await this.notificationModel
      .aggregate<{ count: number }>([
        { $match: match },
        {
          $lookup: {
            from: 'notification_reads',
            let: { nid: { $toString: '$_id' } },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$uid', user._id] },
                      { $eq: ['$notificationId', '$$nid'] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: 'reads',
          },
        },
        { $match: { reads: { $size: 0 } } },
        { $limit: UNREAD_COUNT_CAP + 1 },
        { $count: 'count' },
      ])
      .exec();

    return Math.min(result[0]?.count ?? 0, UNREAD_COUNT_CAP);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Mark one notification read.
   *
   * Re-runs the full visibility predicate before writing. Skipping it would
   * leak existence: an attacker could probe ids and learn which ones are real
   * from whether the call succeeded.
   */
  async markNotificationRead(
    user: User,
    id: string,
    activeBranchId?: string | null,
  ): Promise<boolean> {
    const scope = await this.scopeFor(user, activeBranchId);
    const row = await this.notificationModel
      .findOne({
        _id: id,
        ...this.visibilityFilter(scope),
      } as NotificationFilter)
      .exec();
    if (!row) {
      throw new ForbiddenException('Notification not found.');
    }

    if (row.audience === NotificationAudience.USER) {
      await this.notificationModel
        .updateOne({ _id: row._id, readAt: null } as NotificationFilter, {
          $set: { readAt: new Date() },
        })
        .exec();
      return true;
    }

    // Branch row — read state belongs to the reader, not the row.
    await this.readModel
      .updateOne(
        { uid: user._id, notificationId: String(row._id) },
        { $setOnInsert: { expiresAt: row.expiresAt } },
        { upsert: true },
      )
      .exec();
    return true;
  }

  /**
   * Mark everything currently visible as read.
   *
   * Writes one watermark and deletes the per-row reads it supersedes, so the
   * gesture stays O(1) however large the feed is. Direct rows still get their
   * inline readAt stamped, so the covered unread index keeps working without a
   * cursor lookup.
   */
  async markAllNotificationsRead(user: User): Promise<boolean> {
    const now = new Date();
    await this.cursorModel
      .updateOne(
        { uid: user._id },
        { $set: { readAllBefore: now } },
        { upsert: true },
      )
      .exec();
    await Promise.all([
      this.notificationModel
        .updateMany(
          {
            audience: NotificationAudience.USER,
            uid: user._id,
            readAt: null,
            createdAt: { $lte: now },
          },
          { $set: { readAt: now } },
        )
        .exec(),
      this.readModel
        .deleteMany({ uid: user._id, createdAt: { $lte: now } })
        .exec(),
    ]);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Fan-out support (used by NotificationsService.notify)
  // ---------------------------------------------------------------------------

  /**
   * Everyone who should receive the PUSH for a branch notification: the owner
   * plus every staff member attached to the branch who holds the required
   * permission.
   *
   * The stored row is shared; only the pushes fan out.
   */
  async branchPushRecipients(
    branchId: string,
    requiredPermission?: string | null,
    excludeUid?: string,
  ): Promise<string[]> {
    const branch = await this.branchModel
      .findById(branchId)
      .select('uid')
      .lean()
      .exec();
    if (!branch) return [];

    const staff = await this.userModel
      .find({ branchIds: branchId })
      .select('role branchAccess')
      .populate('role')
      .lean()
      .exec();

    const recipients = new Set<string>([String(branch.uid)]);
    for (const member of staff) {
      if (!requiredPermission) {
        recipients.add(String(member._id));
        continue;
      }
      // The grants this member holds ON THIS BRANCH. Reading the union here
      // notified a staff member assigned to Makati and BGC about BGC events
      // they could only act on in Makati.
      const granted = await resolveGrantedPermissionNames(
        (member.role as unknown as Role)?.roleId,
        grantsForBranch(member.branchAccess, branchId),
        this.permissionModel,
      );
      if (granted.has(requiredPermission)) recipients.add(String(member._id));
    }

    if (excludeUid) recipients.delete(excludeUid);
    return [...recipients];
  }

  /** The owner uid for a branch, denormalized onto BRANCH rows at write time. */
  async ownerUidOf(branchId: string): Promise<string | null> {
    const branch = await this.branchModel
      .findById(branchId)
      .select('uid')
      .lean()
      .exec();
    return branch ? String(branch.uid) : null;
  }
}
