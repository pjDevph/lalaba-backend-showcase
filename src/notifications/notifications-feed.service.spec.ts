import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';

import {
  NotificationsFeedService,
  UNREAD_COUNT_CAP,
} from './notifications-feed.service';
import {
  Notification,
  NotificationSchema,
} from './schemas/notification.schema';
import {
  NotificationRead,
  NotificationReadSchema,
} from './schemas/notification-read.schema';
import {
  NotificationReadCursor,
  NotificationReadCursorSchema,
} from './schemas/notification-read-cursor.schema';
import {
  NotificationAudience,
  NotificationCategory,
  NotificationType,
} from './notification.enums';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';

/**
 * The feed's job is deciding who may see what, and whether they have seen it.
 * Both are easy to get subtly wrong in ways no type checks — a branch row read
 * by the wrong person, or read once and thereby hidden from everyone else — so
 * these run against a real Mongo rather than mocks.
 */
describe('NotificationsFeedService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: NotificationsFeedService;

  const BRANCH_A = new Types.ObjectId().toString();
  const BRANCH_B = new Types.ObjectId().toString();

  const makeRole = async (roleId: string) =>
    (await connection.models[Role.name].findOne({ roleId }).exec()) ??
    (await connection.models[Role.name].create({
      roleId,
      roleName: roleId,
      description: `${roleId} role`,
    }));

  /** Returns the user as the guard would attach it: role POPULATED. */
  const makeUser = async (
    roleId: string,
    opts: { branchIds?: string[]; permissionNames?: string[] } = {},
  ): Promise<User> => {
    const role = await makeRole(roleId);
    const uid = new Types.ObjectId().toString();
    let permissionIds: string[] = [];
    if (opts.permissionNames?.length) {
      const perms = await connection.models[Permission.name].find({
        permissionName: { $in: opts.permissionNames },
      });
      permissionIds = perms.map((p) => String(p._id));
    }
    // Grants are per branch: the named permissions are held on EVERY branch
    // this fixture user is assigned to. `permissionIds` stays populated as the
    // union, mirroring what deriveGrantFields writes in production.
    const branchIds = opts.branchIds ?? [];
    await connection.models[User.name].create({
      _id: uid,
      firstName: 'Test',
      lastName: 'Person',
      email: `${uid}@example.com`,
      phoneNumber: '09171234567',
      role: role._id,
      branchAccess: branchIds.map((branchId) => ({ branchId, permissionIds })),
      branchIds,
      permissionIds,
    });
    const doc = await connection.models[User.name]
      .findById(uid)
      .populate('role')
      .exec();
    return doc;
  };

  const makeBranch = async (branchId: string, ownerUid: string) =>
    connection.models[Branch.name].create({
      _id: branchId,
      uid: ownerUid,
      branchName: 'Test Branch',
      branchAddress: {
        regionName: 'NCR',
        provinceName: 'Metro Manila',
        cityMunicipalityName: 'Quezon City',
        barangayName: 'Bagumbayan',
        streetAddress: '1 Test St',
      },
      branchMapLocation: { latitude: 14.6, longitude: 121.05 },
      branchPhoneNumber: '09171234567',
      operatingHours: {},
    });

  const makeNotification = async (
    over: Partial<Record<string, unknown>> = {},
  ) =>
    connection.models[Notification.name].create({
      audience: NotificationAudience.USER,
      type: NotificationType.ORDER_STATUS,
      category: NotificationCategory.ORDER,
      title: 'Order update',
      body: 'Something happened.',
      expiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    });

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: Notification.name, schema: NotificationSchema },
          { name: NotificationRead.name, schema: NotificationReadSchema },
          {
            name: NotificationReadCursor.name,
            schema: NotificationReadCursorSchema,
          },
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: Permission.name, schema: PermissionSchema },
        ]),
      ],
      providers: [NotificationsFeedService],
    }).compile();

    service = module.get(NotificationsFeedService);
    connection = module.get<Connection>(getConnectionToken());
    // The unique partial index on sourceEventId is what makes notify()
    // idempotent, so the duplicate test needs it actually built.
    await connection.models[Notification.name].syncIndexes();
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      Notification.name,
      NotificationRead.name,
      NotificationReadCursor.name,
      User.name,
      Role.name,
      Branch.name,
      Permission.name,
    ]) {
      await connection.models[name].deleteMany({});
    }
    await connection.models[Permission.name].create({
      permissionName: 'order_update_status',
      description: 'Update order status',
    });
  });

  describe('visibleBranchIds', () => {
    it('gives a merchant the branches they own', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      await makeBranch(BRANCH_B, 'someone-else');

      expect(await service.visibleBranchIds(owner)).toEqual([BRANCH_A]);
    });

    it('gives a washer the branches they own', async () => {
      const washer = await makeUser('washer');
      await makeBranch(BRANCH_A, washer._id);

      expect(await service.visibleBranchIds(washer)).toEqual([BRANCH_A]);
    });

    it('gives staff their explicitly assigned branches, not ownership', async () => {
      const staff = await makeUser('staff', { branchIds: [BRANCH_A] });
      await makeBranch(BRANCH_A, 'the-owner');

      expect(await service.visibleBranchIds(staff)).toEqual([BRANCH_A]);
    });

    it('gives customers and couriers none', async () => {
      const customer = await makeUser('customer');
      const courier = await makeUser('courier');

      expect(await service.visibleBranchIds(customer)).toEqual([]);
      expect(await service.visibleBranchIds(courier)).toEqual([]);
    });
  });

  describe('visibility', () => {
    it('shows a direct row only to its addressee', async () => {
      const mine = await makeUser('customer');
      const theirs = await makeUser('customer');
      await makeNotification({ uid: mine._id });

      expect((await service.myNotifications(mine, 20, 0)).total).toBe(1);
      expect((await service.myNotifications(theirs, 20, 0)).total).toBe(0);
    });

    it('shows an unrestricted branch row to owner and staff alike', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      const staff = await makeUser('staff', { branchIds: [BRANCH_A] });
      await makeNotification({
        audience: NotificationAudience.BRANCH,
        branchId: BRANCH_A,
        uid: null,
      });

      expect((await service.myNotifications(owner, 20, 0)).total).toBe(1);
      expect(
        (await service.myNotifications(staff, 20, 0, undefined, BRANCH_A))
          .total,
      ).toBe(1);
    });

    it('hides a branch row from staff working a DIFFERENT branch', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      await makeBranch(BRANCH_B, owner._id);
      const staff = await makeUser('staff', {
        branchIds: [BRANCH_A, BRANCH_B],
      });
      await makeNotification({
        audience: NotificationAudience.BRANCH,
        branchId: BRANCH_A,
        uid: null,
      });

      expect(
        (await service.myNotifications(staff, 20, 0, undefined, BRANCH_B))
          .total,
      ).toBe(0);
    });

    it('hides a permission-scoped branch row from staff who lack it', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      // 'log_view' is an owner-floor permission, NOT a staff default.
      const staff = await makeUser('staff', { branchIds: [BRANCH_A] });
      await makeNotification({
        audience: NotificationAudience.BRANCH,
        branchId: BRANCH_A,
        uid: null,
        requiredPermission: 'log_view',
      });

      expect((await service.myNotifications(owner, 20, 0)).total).toBe(1);
      expect((await service.myNotifications(staff, 20, 0)).total).toBe(0);
    });

    it('shows a permission-scoped row to staff granted it on that branch', async () => {
      // There is no implicit staff floor any more — order_update_status has to
      // be granted, and granted HERE.
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      const staff = await makeUser('staff', {
        branchIds: [BRANCH_A],
        permissionNames: ['order_update_status'],
      });
      await makeNotification({
        audience: NotificationAudience.BRANCH,
        branchId: BRANCH_A,
        uid: null,
        requiredPermission: 'order_update_status',
      });

      expect(
        (await service.myNotifications(staff, 20, 0, undefined, BRANCH_A))
          .total,
      ).toBe(1);
    });

    it('hides a permission-scoped row from staff granted it on another branch only', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      await makeBranch(BRANCH_B, owner._id);
      const staff = await makeUser('staff', {
        branchIds: [BRANCH_A, BRANCH_B],
      });
      // Grant order_update_status on BRANCH_A only.
      const perm = await connection.models[Permission.name].findOne({
        permissionName: 'order_update_status',
      });
      await connection.models[User.name].updateOne(
        { _id: staff._id },
        {
          $set: {
            branchAccess: [
              { branchId: BRANCH_A, permissionIds: [perm!._id] },
              { branchId: BRANCH_B, permissionIds: [] },
            ],
          },
        },
      );
      const reloaded = (await connection.models[User.name]
        .findById(staff._id)
        .populate('role')
        .exec()) as unknown as User;
      await makeNotification({
        audience: NotificationAudience.BRANCH,
        branchId: BRANCH_B,
        uid: null,
        requiredPermission: 'order_update_status',
      });

      expect(
        (await service.myNotifications(reloaded, 20, 0, undefined, BRANCH_B))
          .total,
      ).toBe(0);
    });

    it('hides expired rows the TTL sweep has not yet reaped', async () => {
      const user = await makeUser('customer');
      await makeNotification({
        uid: user._id,
        expiresAt: new Date(Date.now() - 1000),
      });

      expect((await service.myNotifications(user, 20, 0)).total).toBe(0);
    });
  });

  describe('read state', () => {
    it('keeps a branch row unread for a colleague after one staff reads it', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      const staffA = await makeUser('staff', { branchIds: [BRANCH_A] });
      const staffB = await makeUser('staff', { branchIds: [BRANCH_A] });
      const row = await makeNotification({
        audience: NotificationAudience.BRANCH,
        branchId: BRANCH_A,
        uid: null,
      });

      await service.markNotificationRead(staffA, String(row._id), BRANCH_A);

      const a = await service.myNotifications(
        staffA,
        20,
        0,
        undefined,
        BRANCH_A,
      );
      const b = await service.myNotifications(
        staffB,
        20,
        0,
        undefined,
        BRANCH_A,
      );
      expect(a.data[0].isRead).toBe(true);
      expect(b.data[0].isRead).toBe(false);
      expect(await service.myUnreadNotificationCount(staffB, BRANCH_A)).toBe(1);
    });

    it('marks a direct row read inline', async () => {
      const user = await makeUser('customer');
      const row = await makeNotification({ uid: user._id });

      await service.markNotificationRead(user, String(row._id));

      const page = await service.myNotifications(user, 20, 0);
      expect(page.data[0].isRead).toBe(true);
      expect(await service.myUnreadNotificationCount(user)).toBe(0);
    });

    it('refuses to mark a row the caller cannot see', async () => {
      const mine = await makeUser('customer');
      const theirs = await makeUser('customer');
      const row = await makeNotification({ uid: mine._id });

      // Rejected rather than silently ignored: a no-op would still confirm
      // the id exists.
      await expect(
        service.markNotificationRead(theirs, String(row._id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('treats everything before the watermark as read', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      await makeNotification({
        audience: NotificationAudience.BRANCH,
        branchId: BRANCH_A,
        uid: null,
      });
      await makeNotification({ uid: owner._id });

      await service.markAllNotificationsRead(owner);

      const page = await service.myNotifications(owner, 20, 0);
      expect(page.data.every((i) => i.isRead)).toBe(true);
      expect(await service.myUnreadNotificationCount(owner)).toBe(0);
    });

    it('leaves rows created after "mark all read" unread', async () => {
      const user = await makeUser('customer');
      await makeNotification({ uid: user._id });
      await service.markAllNotificationsRead(user);

      await makeNotification({ uid: user._id, title: 'Newer' });

      expect(await service.myUnreadNotificationCount(user)).toBe(1);
    });

    it('is idempotent', async () => {
      const user = await makeUser('customer');
      await makeNotification({ uid: user._id });

      await service.markAllNotificationsRead(user);
      await service.markAllNotificationsRead(user);

      expect(await service.myUnreadNotificationCount(user)).toBe(0);
    });
  });

  describe('unread count', () => {
    it('caps at UNREAD_COUNT_CAP so the badge never scans a whole history', async () => {
      const user = await makeUser('customer');
      for (let i = 0; i < UNREAD_COUNT_CAP + 25; i++) {
        await makeNotification({ uid: user._id, title: `Row ${i}` });
      }

      expect(await service.myUnreadNotificationCount(user)).toBe(
        UNREAD_COUNT_CAP,
      );
    });
  });

  describe('persist', () => {
    it('returns null instead of duplicating when sourceEventId repeats', async () => {
      const first = await service.persist({
        audience: NotificationAudience.USER,
        uid: 'someone',
        type: NotificationType.ORDER_STATUS,
        category: NotificationCategory.ORDER,
        title: 'Order update',
        body: 'Picked up.',
        sourceEventId: 'event-1:CUSTOMER',
      });
      const second = await service.persist({
        audience: NotificationAudience.USER,
        uid: 'someone',
        type: NotificationType.ORDER_STATUS,
        category: NotificationCategory.ORDER,
        title: 'Order update',
        body: 'Picked up.',
        sourceEventId: 'event-1:CUSTOMER',
      });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(
        await connection.models[Notification.name].countDocuments({}),
      ).toBe(1);
    });

    it('does not collide rows that simply have no sourceEventId', async () => {
      // The partial index exists precisely so "no value" is not a shared value.
      await service.persist({
        audience: NotificationAudience.USER,
        uid: 'someone',
        type: NotificationType.STAFF_LOGIN,
        category: NotificationCategory.STAFF,
        title: 'Staff signed in',
        body: 'A signed in.',
      });
      await service.persist({
        audience: NotificationAudience.USER,
        uid: 'someone',
        type: NotificationType.STAFF_LOGIN,
        category: NotificationCategory.STAFF,
        title: 'Staff signed in',
        body: 'B signed in.',
      });

      expect(
        await connection.models[Notification.name].countDocuments({}),
      ).toBe(2);
    });
  });

  describe('branchPushRecipients', () => {
    it('includes the owner and permitted staff, and excludes the actor', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      const permitted = await makeUser('staff', {
        branchIds: [BRANCH_A],
        permissionNames: ['order_update_status'],
      });
      const other = await makeUser('staff', {
        branchIds: [BRANCH_B],
        permissionNames: ['order_update_status'],
      });

      const all = await service.branchPushRecipients(
        BRANCH_A,
        'order_update_status',
      );
      expect(all.sort()).toEqual([owner._id, permitted._id].sort());
      expect(all).not.toContain(other._id);

      const minusActor = await service.branchPushRecipients(
        BRANCH_A,
        'order_update_status',
        permitted._id,
      );
      expect(minusActor).toEqual([owner._id]);
    });

    it('drops staff who lack the required permission', async () => {
      const owner = await makeUser('merchant');
      await makeBranch(BRANCH_A, owner._id);
      const staff = await makeUser('staff', { branchIds: [BRANCH_A] });

      const recipients = await service.branchPushRecipients(
        BRANCH_A,
        'log_view',
      );
      expect(recipients).toEqual([owner._id]);
      expect(recipients).not.toContain(staff._id);
    });
  });
});
