import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import {
  AccountDeletionService,
  ANONYMIZED_DISPLAY_NAME,
  BLOCKER_ACTIVE_ONLINE_ORDERS,
  BLOCKER_ACTIVE_STAFF_EXISTS,
  BLOCKER_ACTIVE_WASHER_BOOKINGS,
  BLOCKER_UNRESOLVED_POS_ORDERS,
  BLOCKER_WALLET_BALANCE_REMAINING,
  DELETION_GRACE_DAYS,
  anonymizedEmail,
} from './account-deletion.service';
import { AccountStatus, User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  PosOrder,
  PosOrderSchema,
} from '../pos_orders/schemas/pos-order.schema';
import {
  WasherBooking,
  WasherBookingSchema,
} from '../washer/schemas/washer-booking.schema';
import { Device, DeviceSchema } from '../devices/schemas/device.schema';
import {
  ActivityLog,
  ActivityLogSchema,
} from '../activity-logs/schemas/activity-log.schema';
import {
  AccountDeletionRecord,
  AccountDeletionRecordSchema,
} from './schemas/account-deletion-record.schema';
import { FirebaseService } from '../firebase/firebase.service';
import { CourierVerificationService } from '../courier-verification/courier-verification.service';

const makeDaySchedule = () => ({
  isOpen: true,
  is24Hours: false,
  timeSlots: [{ open: '08:00', close: '20:00' }],
});

const makeOperatingHours = () => ({
  monday: makeDaySchedule(),
  tuesday: makeDaySchedule(),
  wednesday: makeDaySchedule(),
  thursday: makeDaySchedule(),
  friday: makeDaySchedule(),
  saturday: makeDaySchedule(),
  sunday: { isOpen: false, is24Hours: false, timeSlots: [] },
});

describe('AccountDeletionService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: AccountDeletionService;
  let module: TestingModule;
  const cacheMock = { del: jest.fn(), get: jest.fn(), set: jest.fn() };
  // Firebase identity deletion is a real external call; mocked here (see
  // KNOWN_RISKS — the true Firebase behaviour is not proven by this suite).
  const deleteUserMock = jest.fn().mockResolvedValue(undefined);
  const firebaseMock = { getAuth: () => ({ deleteUser: deleteUserMock }) };
  // Liveness selfies live in object storage, so their erasure is a real
  // external call too; mocked here and only asserted as "was invoked".
  const eraseSelfiesMock = jest.fn().mockResolvedValue(undefined);
  const courierVerificationMock = { eraseForUser: eraseSelfiesMock };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
          { name: PosOrder.name, schema: PosOrderSchema },
          { name: WasherBooking.name, schema: WasherBookingSchema },
          { name: Device.name, schema: DeviceSchema },
          { name: ActivityLog.name, schema: ActivityLogSchema },
          {
            name: AccountDeletionRecord.name,
            schema: AccountDeletionRecordSchema,
          },
        ]),
      ],
      providers: [
        AccountDeletionService,
        { provide: CACHE_MANAGER, useValue: cacheMock },
        { provide: FirebaseService, useValue: firebaseMock },
        {
          provide: CourierVerificationService,
          useValue: courierVerificationMock,
        },
      ],
    }).compile();

    service = module.get<AccountDeletionService>(AccountDeletionService);
    mongoConnection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await module.close();
    await mongod.stop();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    const collections = mongoConnection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  const getOrCreateRole = async (roleId: string) => {
    const existing = await mongoConnection.model(Role.name).findOne({ roleId });
    if (existing) return existing;
    return mongoConnection.model(Role.name).create({
      _id: new Types.ObjectId(),
      roleId,
      roleName: roleId,
      description: roleId,
    });
  };

  const createUser = async (
    uid: string,
    roleId: string,
    extra: Record<string, unknown> = {},
  ) => {
    const role = await getOrCreateRole(roleId);
    return mongoConnection.model(User.name).create({
      _id: uid,
      role: role._id,
      email: `${uid}@test.local`,
      firstName: 'Test',
      lastName: 'User',
      phoneNumber: '09171234567',
      ...extra,
    });
  };

  const createBranch = async (uid: string) =>
    mongoConnection.model(Branch.name).create({
      uid,
      branchName: `Branch of ${uid}`,
      branchPhoneNumber: '09171234567',
      branchAddress: {
        regionName: 'NCR',
        provinceName: 'Metro Manila',
        cityMunicipalityName: 'Makati',
        barangayName: 'Bel-Air',
        streetAddress: '123 Test St',
      },
      branchMapLocation: { latitude: 14.5547, longitude: 121.0244 },
      operatingHours: makeOperatingHours(),
    });

  // Raw insert — OnlineOrder full validation isn't the subject here; the
  // service only reads provider.branchId / customer.uid / status.
  const insertOrder = async (
    branchId: string,
    customerUid: string,
    status: string,
  ) =>
    mongoConnection.collection('online_orders').insertOne({
      provider: { branchId },
      customer: { uid: customerUid },
      status,
    });

  it('[HP] returns no blockers and schedules deletion for a clean merchant', async () => {
    await createUser('merchant-1', 'merchant');
    const branch = await createBranch('merchant-1');
    await insertOrder(String(branch._id), 'cust-9', 'completed');
    await mongoConnection
      .model(Wallet.name)
      .create({ branchId: String(branch._id), balanceCentavos: 0 });

    expect(await service.listBlockers('merchant-1')).toEqual([]);

    const before = Date.now();
    const user = await service.requestDeletion('merchant-1');
    expect(user.isActive).toBe(false);
    expect(user.accountStatus).toBe(AccountStatus.DELETION_PENDING);
    expect(cacheMock.del).toHaveBeenCalledWith('user:merchant-1');

    const persisted = await mongoConnection
      .model(User.name)
      .findById('merchant-1');
    expect(persisted.isActive).toBe(false);
    // Grace period, not an immediate erasure.
    const graceMs = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;
    expect(persisted.deletionScheduledAt.getTime()).toBeGreaterThanOrEqual(
      before + graceMs - 5000,
    );
    expect(persisted.firstName).toBe('Test'); // nothing erased yet

    const record = await mongoConnection
      .model(AccountDeletionRecord.name)
      .findOne({ uid: 'merchant-1' });
    expect(record.roleId).toBe('merchant');
    expect(record.completedAt).toBeNull();
  });

  it('[NP] blocks a merchant with active online orders on their branches', async () => {
    await createUser('merchant-1', 'merchant');
    const branch = await createBranch('merchant-1');
    await insertOrder(String(branch._id), 'cust-1', 'laundry_in_progress');
    await insertOrder(
      String(branch._id),
      'cust-2',
      'pending_provider_acceptance',
    );
    await insertOrder(String(branch._id), 'cust-3', 'cancelled'); // terminal — ignored

    const blockers = await service.listBlockers('merchant-1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe(BLOCKER_ACTIVE_ONLINE_ORDERS);
    expect(blockers[0].count).toBe(2);
    expect(blockers[0].ids).toHaveLength(2);

    await expect(service.requestDeletion('merchant-1')).rejects.toThrow(
      BadRequestException,
    );
    const persisted = await mongoConnection
      .model(User.name)
      .findById('merchant-1');
    expect(persisted.isActive).toBe(true);
  });

  it('[NP] blocks a washer whose anchor-branch wallet still holds a balance', async () => {
    await createUser('washer-1', 'washer');
    await mongoConnection.model(WasherProfile.name).create({
      uid: 'washer-1',
      displayName: 'Washer One',
      branchId: 'anchor-washer-1',
    });
    await mongoConnection
      .model(Wallet.name)
      .create({ branchId: 'anchor-washer-1', balanceCentavos: 12500 });

    const blockers = await service.listBlockers('washer-1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe(BLOCKER_WALLET_BALANCE_REMAINING);
    expect(blockers[0].message).toContain('₱125.00');
  });

  it('[NP] blocks a merchant with active (non-archived) staff', async () => {
    await createUser('merchant-1', 'merchant');
    await createUser('staff-1', 'staff', { merchantId: 'merchant-1' });
    await createUser('staff-2', 'staff', {
      merchantId: 'merchant-1',
      isActive: false,
    });
    await createUser('staff-3', 'staff', {
      merchantId: 'merchant-1',
      isArchived: true,
    });

    const blockers = await service.listBlockers('merchant-1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe(BLOCKER_ACTIVE_STAFF_EXISTS);
    expect(blockers[0].ids).toEqual(['staff-1']);
  });

  it('[HP] blocks a customer only on their own active orders', async () => {
    await createUser('cust-1', 'customer');
    await insertOrder('some-branch', 'cust-1', 'pickup_en_route');
    await insertOrder('some-branch', 'cust-1', 'refunded'); // terminal

    const blockers = await service.listBlockers('cust-1');
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe(BLOCKER_ACTIVE_ONLINE_ORDERS);
    expect(blockers[0].count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Extra blockers ported from feat/account-deletion-v2
  // -------------------------------------------------------------------------

  it('[NP] blocks a merchant with unresolved walk-in (POS) orders', async () => {
    await createUser('merchant-1', 'merchant');
    const branch = await createBranch('merchant-1');
    const branchId = String(branch._id);
    await mongoConnection.collection('pos_orders').insertMany([
      { branchId, claimCode: 'A1', laundryStatus: 'in_progress' },
      { branchId, claimCode: 'A2', laundryStatus: 'ready' },
      { branchId, claimCode: 'A3', laundryStatus: 'claimed' }, // terminal
      { branchId, claimCode: 'A4', laundryStatus: 'void' }, // terminal
    ]);

    const blockers = await service.listBlockers('merchant-1');
    expect(blockers.map((b) => b.code)).toContain(
      BLOCKER_UNRESOLVED_POS_ORDERS,
    );
    const pos = blockers.find((b) => b.code === BLOCKER_UNRESOLVED_POS_ORDERS)!;
    expect(pos.count).toBe(2);
  });

  it('[NP] blocks a washer with an in-flight legacy booking', async () => {
    await createUser('washer-1', 'washer');
    await mongoConnection.model(WasherProfile.name).create({
      uid: 'washer-1',
      displayName: 'Washer One',
      branchId: 'anchor-washer-1',
    });
    await mongoConnection.collection('washer_bookings').insertMany([
      { washerId: 'washer-1', customerId: 'cust-1', status: 'CONFIRMED' },
      { washerId: 'washer-1', customerId: 'cust-2', status: 'COMPLETED' },
    ]);

    const blockers = await service.listBlockers('washer-1');
    const booking = blockers.find(
      (b) => b.code === BLOCKER_ACTIVE_WASHER_BOOKINGS,
    )!;
    expect(booking).toBeDefined();
    expect(booking.count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Grace period, cancellation, and erasure
  // -------------------------------------------------------------------------

  it('[NP] a second deletion request while one is pending is refused', async () => {
    await createUser('cust-1', 'customer');
    await service.requestDeletion('cust-1');
    await expect(service.requestDeletion('cust-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('[HP] cancelling a pending request restores access and closes the record', async () => {
    await createUser('cust-1', 'customer');
    await service.requestDeletion('cust-1');

    const restored = await service.cancelDeletion('cust-1', 'cust-1');
    expect(restored.isActive).toBe(true);
    expect(restored.accountStatus).toBe(AccountStatus.ACTIVE);
    expect(restored.deletionScheduledAt).toBeNull();

    const record = await mongoConnection
      .model(AccountDeletionRecord.name)
      .findOne({ uid: 'cust-1' });
    expect(record.cancelledAt).not.toBeNull();
    expect(record.cancelledBy).toBe('cust-1');

    // A cancelled request no longer qualifies for the sweep, even long after
    // the original scheduled date.
    const far = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    expect(await service.processScheduledDeletions(far)).toEqual({
      processed: 0,
      failed: 0,
    });
  });

  it('[NP] cancelling without a pending request is refused', async () => {
    await createUser('cust-1', 'customer');
    await expect(service.cancelDeletion('cust-1', 'cust-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('[HP] the sweep ignores accounts still inside the grace period', async () => {
    await createUser('cust-1', 'customer');
    await service.requestDeletion('cust-1');

    expect(await service.processScheduledDeletions(new Date())).toEqual({
      processed: 0,
      failed: 0,
    });
    const persisted = await mongoConnection.model(User.name).findById('cust-1');
    expect(persisted.accountStatus).toBe(AccountStatus.DELETION_PENDING);
    expect(persisted.email).toBe('cust-1@test.local');
  });

  it('[HP] erases PII but retains financial/audit history once the grace period elapses', async () => {
    await createUser('washer-1', 'washer', {
      homeAddress: { streetAddress: '123 Real St' },
      fcmTokens: ['token-1'],
    });
    await mongoConnection.model(WasherProfile.name).create({
      uid: 'washer-1',
      displayName: 'Real Name',
      phone: '09171234567',
      branchId: 'anchor-washer-1',
      certProofUrls: ['https://public.example/cert.jpg'],
      certProofObjectKeys: ['cert-proofs/washer/x/y.jpg'],
    });
    // Raw insert — Device's full validation isn't the subject; erasure only
    // matches on uid.
    await mongoConnection
      .model(Device.name)
      .collection.insertOne({ uid: 'washer-1', fcmToken: 'token-1' });
    await mongoConnection.collection('activity_logs').insertOne({
      actorId: 'washer-1',
      actorName: 'Real Name',
      actorEmail: 'washer-1@test.local',
      action: 'LOGIN',
    });
    // Completed order: money history that MUST survive, with a PII snapshot
    // that must not.
    const orderId = (
      await mongoConnection.collection('online_orders').insertOne({
        provider: { branchId: 'anchor-washer-1' },
        customer: {
          uid: 'washer-1',
          displayName: 'Real Name',
          maskedPhone: '0917***4567',
          address: { streetAddress: '123 Real St' },
          areaLabel: 'Bel-Air, Makati',
        },
        status: 'completed',
        pricing: { customerTotalCentavos: 45000 },
      })
    ).insertedId;
    await mongoConnection.collection('washer_bookings').insertOne({
      washerId: 'other',
      customerId: 'washer-1',
      customerName: 'Real Name',
      customerPhone: '09171234567',
      status: 'COMPLETED',
    });
    await mongoConnection
      .model(Wallet.name)
      .create({ branchId: 'anchor-washer-1', balanceCentavos: 0 });

    await service.requestDeletion('washer-1');
    const after = new Date(
      Date.now() + (DELETION_GRACE_DAYS + 1) * 24 * 3600 * 1000,
    );
    expect(await service.processScheduledDeletions(after)).toEqual({
      processed: 1,
      failed: 0,
    });

    // --- ERASED ---
    const user = await mongoConnection.model(User.name).findById('washer-1');
    expect(user.accountStatus).toBe(AccountStatus.DELETED);
    expect(user.firstName).toBe('Deleted');
    expect(user.lastName).toBe('User');
    expect(user.email).toBe(anonymizedEmail('washer-1'));
    expect(user.phoneNumber).toBe('');
    expect(user.homeAddress?.streetAddress ?? null).toBeNull();
    expect(user.fcmTokens).toEqual([]);
    expect(user.deletedAt).not.toBeNull();

    expect(deleteUserMock).toHaveBeenCalledWith('washer-1');
    expect(eraseSelfiesMock).toHaveBeenCalledWith('washer-1');
    expect(await mongoConnection.model(Device.name).countDocuments()).toBe(0);

    const profile = await mongoConnection
      .model(WasherProfile.name)
      .findOne({ uid: 'washer-1' });
    expect(profile.displayName).toBe(ANONYMIZED_DISPLAY_NAME);
    expect(profile.phone).toBeNull();
    expect(profile.certProofUrls).toEqual([]);
    expect(profile.certProofObjectKeys).toEqual([]);

    const log = (await mongoConnection
      .collection('activity_logs')
      .findOne({ actorId: 'washer-1' }))!;
    expect(log.actorName).toBe(ANONYMIZED_DISPLAY_NAME);
    expect(log.actorEmail).toBe(anonymizedEmail('washer-1'));

    const order = (await mongoConnection
      .collection('online_orders')
      .findOne({ _id: orderId }))!;
    expect(order.customer.displayName).toBe(ANONYMIZED_DISPLAY_NAME);
    expect(order.customer.maskedPhone).toBeNull();
    expect(order.customer.address).toBeNull();
    expect(order.customer.areaLabel).toBeNull();

    const booking = (await mongoConnection
      .collection('washer_bookings')
      .findOne({ customerId: 'washer-1' }))!;
    expect(booking.customerName).toBe(ANONYMIZED_DISPLAY_NAME);
    expect(booking.customerPhone).toBeNull();

    // --- RETAINED ---
    // Linkage anonymized, not broken: the order still points at the account
    // and still carries the money.
    expect(order.customer.uid).toBe('washer-1');
    expect(order.pricing.customerTotalCentavos).toBe(45000);
    expect(order.status).toBe('completed');
    expect(await mongoConnection.model(Wallet.name).countDocuments()).toBe(1);
    expect(
      await mongoConnection.collection('activity_logs').countDocuments(),
    ).toBe(1);

    const record = await mongoConnection
      .model(AccountDeletionRecord.name)
      .findOne({ uid: 'washer-1' });
    expect(record.completedAt).not.toBeNull();
    expect(record.processingSummary.userAnonymized).toBe(true);
    expect(record.processingSummary.devicesRemoved).toBe(1);
    expect(record.processingSummary.firebaseIdentityDeleted).toBe(true);
    expect(record.processingSummary.onlineOrderSnapshotsRedacted).toBe(1);
  });

  it('[HP] the sweep is idempotent — a second pass finds nothing to erase', async () => {
    await createUser('cust-1', 'customer');
    await service.requestDeletion('cust-1');
    const after = new Date(
      Date.now() + (DELETION_GRACE_DAYS + 1) * 24 * 3600 * 1000,
    );
    expect(await service.processScheduledDeletions(after)).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(await service.processScheduledDeletions(after)).toEqual({
      processed: 0,
      failed: 0,
    });
  });

  it('[NP] an already-deleted account cannot request deletion again', async () => {
    await createUser('cust-1', 'customer');
    await service.requestDeletion('cust-1');
    await service.processScheduledDeletions(
      new Date(Date.now() + (DELETION_GRACE_DAYS + 1) * 24 * 3600 * 1000),
    );
    await expect(service.requestDeletion('cust-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  describe('listDeletionQueue', () => {
    it('[HP] filters pending/cancelled/completed and joins display info from the live user', async () => {
      await createUser('cust-cancelled', 'customer', {
        firstName: 'Cancelled',
        lastName: 'One',
      });
      await createUser('cust-completed', 'customer', {
        firstName: 'Completed',
        lastName: 'One',
      });

      // Completed and cancelled first, swept on their own so the sweep's
      // scheduledAt-in-the-past cutoff cannot also catch the pending record
      // created afterward.
      await service.requestDeletion('cust-cancelled');
      await service.cancelDeletion('cust-cancelled', 'admin-1');
      await service.requestDeletion('cust-completed');
      await service.processScheduledDeletions(
        new Date(Date.now() + (DELETION_GRACE_DAYS + 1) * 24 * 3600 * 1000),
      );

      await createUser('cust-pending', 'customer', {
        firstName: 'Pending',
        lastName: 'One',
      });
      await service.requestDeletion('cust-pending');

      const pending = await service.listDeletionQueue('pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].uid).toBe('cust-pending');
      expect(pending[0].displayName).toBe('Pending One');
      expect(pending[0].completedAt).toBeUndefined();

      const cancelled = await service.listDeletionQueue('cancelled');
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].uid).toBe('cust-cancelled');
      expect(cancelled[0].cancelledBy).toBe('admin-1');

      const completed = await service.listDeletionQueue('completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].uid).toBe('cust-completed');
      // The join legitimately shows the anonymized identity here — the
      // account's PII was erased by the sweep that just ran, and the record
      // itself was never allowed to hold any (see the schema's own comment).
      expect(completed[0].displayName).toBe(ANONYMIZED_DISPLAY_NAME);

      expect(await service.listDeletionQueue()).toHaveLength(3);
    });

    it('[EC] returns an empty list rather than throwing when nothing matches', async () => {
      expect(await service.listDeletionQueue('pending')).toEqual([]);
    });
  });
});
