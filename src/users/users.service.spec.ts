import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { UsersService } from './users.service';
import { User, UserSchema } from './schemas/user.schema';
import { Role, RoleSchema } from './schemas/role.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Consent, ConsentSchema } from '../consents/schemas/consent.schema';
import { ConsentsService } from '../consents/consents.service';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntrySchema,
} from '../wallets/schemas/wallet-ledger-entry.schema';
import { WalletsService } from '../wallets/wallets.service';
import {
  TopUpIntent,
  TopUpIntentSchema,
} from '../wallets/schemas/topup-intent.schema';
import { PaymentGatewayService } from '../wallets/gateway/payment-gateway.service';
import { DevPaymentGateway } from '../wallets/gateway/dev-payment.gateway';
import { FirebaseService } from '../firebase/firebase.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyIdToken = jest.fn().mockResolvedValue({
  uid: 'firebase-uid-001',
  email: 'test@example.com',
});

const mockSendPasswordResetEmail = jest.fn().mockResolvedValue(undefined);

const mockFirebaseService = {
  getAuth: jest.fn().mockReturnValue({
    verifyIdToken: mockVerifyIdToken,
  }),
  sendPasswordResetEmail: mockSendPasswordResetEmail,
};

const mockCacheManager = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRegisterInput = (
  roleId: string,
  overrides: Record<string, any> = {},
) => ({
  role: roleId,
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phoneNumber: '09171234567',
  homeAddress: {
    regionName: 'NCR',
    cityMunicipalityName: 'Makati',
    streetAddress: '123 Test St',
  },
  // Covers the mandatory set for every self-registrable role exercised in
  // this suite (customer needs the first two only; merchant/washer also
  // need merchant_agreement) so fixtures work regardless of which role a
  // given test seeds.
  consents: [
    { policyType: 'terms_of_service', version: 'v1' },
    { policyType: 'privacy_policy', version: 'v1' },
    { policyType: 'merchant_agreement', version: 'v1' },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('UsersService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let mongoConnection: Connection;
  let service: UsersService;
  let module: TestingModule;

  beforeAll(async () => {
    // register()'s user-creation + consent-recording is wrapped in a
    // multi-document transaction, which requires a replica set — a plain
    // standalone MongoMemoryServer does not support session.withTransaction().
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: Consent.name, schema: ConsentSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletLedgerEntry.name, schema: WalletLedgerEntrySchema },
          { name: TopUpIntent.name, schema: TopUpIntentSchema },
        ]),
      ],
      providers: [
        UsersService,
        ConsentsService,
        WalletsService,
        { provide: PaymentGatewayService, useClass: DevPaymentGateway },
        { provide: FirebaseService, useValue: mockFirebaseService },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    mongoConnection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await module.close();
    await replSet.stop();
  });

  afterEach(async () => {
    // Reset mock state so each test starts fresh
    jest.clearAllMocks();
    // Restore default successful resolution for verifyIdToken
    mockVerifyIdToken.mockResolvedValue({
      uid: 'firebase-uid-001',
      email: 'test@example.com',
    });
    mockFirebaseService.getAuth.mockReturnValue({
      verifyIdToken: mockVerifyIdToken,
    });
    mockSendPasswordResetEmail.mockResolvedValue(undefined);

    const collections = mongoConnection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // -------------------------------------------------------------------------
  // Helpers to seed roles directly into the in-memory DB
  // -------------------------------------------------------------------------

  async function seedRole(
    roleId: 'merchant' | 'washer' | 'staff' | 'admin' | 'support',
  ): Promise<string> {
    const RoleModel = mongoConnection.model(Role.name, RoleSchema);
    const doc = await RoleModel.create({
      roleId,
      roleName: roleId.charAt(0).toUpperCase() + roleId.slice(1),
      description: `${roleId} role`,
    });
    return String(doc._id);
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('[HP] should create a user with uid and email extracted from the Firebase token', async () => {
      const merchantRoleId = await seedRole('merchant');

      const user = await service.register(
        makeRegisterInput(merchantRoleId),
        'valid-token',
      );

      expect(user._id).toBe('firebase-uid-001');
      expect(user.email).toBe('test@example.com');
      expect(user.firstName).toBe('Juan');
      expect(user.isActive).toBe(true);
    });

    it('[HP] register is idempotent — calling it again with same uid returns existing user without creating a duplicate', async () => {
      const merchantRoleId = await seedRole('merchant');
      const input = makeRegisterInput(merchantRoleId);

      const first = await service.register(input, 'valid-token');
      const second = await service.register(input, 'valid-token');

      expect(second._id).toBe(first._id);

      const UserModel = mongoConnection.model(User.name, UserSchema);
      const count = await UserModel.countDocuments({ _id: 'firebase-uid-001' });
      expect(count).toBe(1);
    });

    it('[HP] should register a washer-role user successfully', async () => {
      const washerRoleId = await seedRole('washer');
      mockVerifyIdToken.mockResolvedValue({
        uid: 'washer-uid-001',
        email: 'washer@example.com',
      });

      const user = await service.register(
        makeRegisterInput(washerRoleId),
        'valid-token',
      );

      expect(user._id).toBe('washer-uid-001');
      expect(user.email).toBe('washer@example.com');
    });

    it('[EC] should throw BadRequestException("Session expired. Please log in again.") when verifyIdToken rejects', async () => {
      const merchantRoleId = await seedRole('merchant');
      mockVerifyIdToken.mockRejectedValue(new Error('Token expired'));

      await expect(
        service.register(makeRegisterInput(merchantRoleId), 'bad-token'),
      ).rejects.toThrow(
        new BadRequestException('Session expired. Please log in again.'),
      );
    });

    it('[EC] should throw BadRequestException when role value is not a valid ObjectId string', async () => {
      await expect(
        service.register(makeRegisterInput('not-an-objectid'), 'valid-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('[EC] should throw BadRequestException when role ObjectId does not exist in the database', async () => {
      const nonExistentRoleId = new Types.ObjectId().toHexString();

      await expect(
        service.register(makeRegisterInput(nonExistentRoleId), 'valid-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('[EC] should throw BadRequestException when role is "staff" — staff cannot self-register', async () => {
      const staffRoleId = await seedRole('staff');

      await expect(
        service.register(makeRegisterInput(staffRoleId), 'valid-token'),
      ).rejects.toThrow(
        new BadRequestException('This registration type is not supported.'),
      );
    });

    it('[EC] same email under a NEW uid is a conflict, not a 500', async () => {
      // The exact production shape: the auth emulator is reset (or the person
      // signs up again via another provider), so a known email returns with a
      // fresh uid. The uid-keyed idempotency check at step 5 cannot see it, and
      // before 5b existed the insert hit the unique email index and escaped as
      // a raw E11000 → INTERNAL_SERVER_ERROR on the client.
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');

      mockVerifyIdToken.mockResolvedValueOnce({
        uid: 'a-completely-different-uid',
        email: 'test@example.com', // same address as the account above
      });

      await expect(
        service.register(makeRegisterInput(merchantRoleId), 'valid-token'),
      ).rejects.toThrow(ConflictException);
    });

    it('[EC] the conflict names the email and points at logging in', async () => {
      // The message is the whole point of the fix — "Internal server error"
      // told the user nothing actionable.
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');
      mockVerifyIdToken.mockResolvedValueOnce({
        uid: 'another-uid',
        email: 'test@example.com',
      });

      await expect(
        service.register(makeRegisterInput(merchantRoleId), 'valid-token'),
      ).rejects.toThrow(/already registered.*logging in/i);
    });

    it('[NP] a repeat call on the SAME uid still returns the account', async () => {
      // 5b must not shadow step 5: the idempotent retry path returns the
      // existing user and must never start reporting a conflict.
      const merchantRoleId = await seedRole('merchant');
      const first = await service.register(
        makeRegisterInput(merchantRoleId),
        'valid-token',
      );
      const again = await service.register(
        makeRegisterInput(merchantRoleId),
        'valid-token',
      );
      expect(String(again._id)).toBe(String(first._id));
    });
  });

  // -------------------------------------------------------------------------
  // findOneByIdWithRole
  // -------------------------------------------------------------------------

  describe('findOneByIdWithRole', () => {
    it('[HP] should return the user with populated role', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');

      const user = await service.findOneByIdWithRole('firebase-uid-001');

      expect(user).not.toBeNull();
      expect(user!._id).toBe('firebase-uid-001');
      // role is populated — it should be an object, not a raw ObjectId string
      expect(typeof user!.role).toBe('object');
    });

    it('[HP] should return null for a uid that does not exist', async () => {
      const result = await service.findOneByIdWithRole('ghost-uid');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // updateUser
  // -------------------------------------------------------------------------

  describe('updateUser', () => {
    it('[HP] should update firstName and return the updated user document', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');

      const updated = await service.updateUser('firebase-uid-001', {
        firstName: 'Pedro',
      });

      expect(updated.firstName).toBe('Pedro');
    });

    it('[HP] should call cache.del to invalidate the user cache after an update', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');

      await service.updateUser('firebase-uid-001', { lastName: 'Santos' });

      expect(mockCacheManager.del).toHaveBeenCalledWith(
        'user:firebase-uid-001',
      );
    });

    it('[EC] should throw NotFoundException when updating a uid that does not exist', async () => {
      await expect(
        service.updateUser('nonexistent-uid', { firstName: 'Ghost' }),
      ).rejects.toThrow(new NotFoundException('User not found'));
    });
  });

  // -------------------------------------------------------------------------
  // deactivateUser
  // -------------------------------------------------------------------------

  describe('deactivateUser', () => {
    it('[HP] should set isActive to false on an active user', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');

      const result = await service.deactivateUser('firebase-uid-001');

      expect(result.isActive).toBe(false);
    });

    it('[HP] should call cache.del to invalidate the user cache after deactivation', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');

      await service.deactivateUser('firebase-uid-001');

      expect(mockCacheManager.del).toHaveBeenCalledWith(
        'user:firebase-uid-001',
      );
    });

    it('[EC] should throw NotFoundException when deactivating a uid that does not exist', async () => {
      await expect(service.deactivateUser('ghost-uid')).rejects.toThrow(
        new NotFoundException('User not found'),
      );
    });

    it('[EC] should throw BadRequestException("User is already deactivated") when user is already inactive', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');
      await service.deactivateUser('firebase-uid-001');

      await expect(service.deactivateUser('firebase-uid-001')).rejects.toThrow(
        new BadRequestException('User is already deactivated'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // deactivateUser — lockout guards
  //
  // reactivateUser is itself @Roles('admin'), so deactivating the wrong admin
  // account has NO in-app undo: recovery means editing the database by hand.
  // These cover the two ways to reach that state.
  // -------------------------------------------------------------------------

  describe('deactivateUser (lockout guards)', () => {
    async function seedUser(uid: string, roleId: string, email: string) {
      const UserModel = mongoConnection.model(User.name, UserSchema);
      await UserModel.create({
        _id: uid,
        email,
        firstName: 'Test',
        lastName: 'User',
        phoneNumber: '09171234567',
        // The schema types `role` as a string ref; Mongoose casts it to an
        // ObjectId on write. Passing a Types.ObjectId here is what the driver
        // wants but not what the TS model declares.
        role: roleId,
        isActive: true,
      });
    }

    it('[SEC] refuses when the actor is the target — an admin cannot lock themselves out', async () => {
      const adminRoleId = await seedRole('admin');
      await seedUser('admin-a', adminRoleId, 'a@lalaba.test');
      await seedUser('admin-b', adminRoleId, 'b@lalaba.test');

      await expect(
        service.deactivateUser('admin-a', 'admin-a'),
      ).rejects.toThrow(BadRequestException);

      // Still active — the guard refused, it did not half-apply.
      const still = await service.findOneById('admin-a');
      expect(still?.isActive).toBe(true);
    });

    it('[HP] still deactivates a DIFFERENT account when an actor is passed', async () => {
      const adminRoleId = await seedRole('admin');
      const merchantRoleId = await seedRole('merchant');
      await seedUser('admin-a', adminRoleId, 'a@lalaba.test');
      await seedUser('merchant-x', merchantRoleId, 'm@lalaba.test');

      const result = await service.deactivateUser('merchant-x', 'admin-a');

      expect(result.isActive).toBe(false);
    });

    it('[SEC] refuses to deactivate the last active admin', async () => {
      const adminRoleId = await seedRole('admin');
      await seedUser('admin-only', adminRoleId, 'only@lalaba.test');

      // No actorUid: this is the branch an internal caller or a future
      // non-self admin path would hit, where the self-check cannot fire.
      await expect(service.deactivateUser('admin-only')).rejects.toThrow(
        /last active admin/i,
      );
    });

    it('[HP] deactivates an admin when another active admin remains', async () => {
      const adminRoleId = await seedRole('admin');
      await seedUser('admin-a', adminRoleId, 'a@lalaba.test');
      await seedUser('admin-b', adminRoleId, 'b@lalaba.test');

      const result = await service.deactivateUser('admin-a', 'admin-b');

      expect(result.isActive).toBe(false);
    });

    it('[SEC] an already-deactivated admin does not count toward the surviving admins', async () => {
      const adminRoleId = await seedRole('admin');
      await seedUser('admin-a', adminRoleId, 'a@lalaba.test');
      await seedUser('admin-b', adminRoleId, 'b@lalaba.test');
      await service.deactivateUser('admin-b', 'admin-a');

      // admin-a is now the only ACTIVE admin, so it must not be removable.
      await expect(service.deactivateUser('admin-a')).rejects.toThrow(
        /last active admin/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // reactivateUser
  // -------------------------------------------------------------------------

  describe('reactivateUser', () => {
    it('[HP] should set isActive to true on a deactivated user', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');
      await service.deactivateUser('firebase-uid-001');

      const result = await service.reactivateUser('firebase-uid-001');

      expect(result.isActive).toBe(true);
    });

    it('[HP] should call cache.del to invalidate the user cache after reactivation', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');
      await service.deactivateUser('firebase-uid-001');
      jest.clearAllMocks();

      await service.reactivateUser('firebase-uid-001');

      expect(mockCacheManager.del).toHaveBeenCalledWith(
        'user:firebase-uid-001',
      );
    });

    it('[EC] should throw NotFoundException when reactivating a uid that does not exist', async () => {
      await expect(service.reactivateUser('ghost-uid')).rejects.toThrow(
        new NotFoundException('User not found'),
      );
    });

    it('[EC] should throw BadRequestException("User is already active") when user is already active', async () => {
      const merchantRoleId = await seedRole('merchant');
      await service.register(makeRegisterInput(merchantRoleId), 'valid-token');

      await expect(service.reactivateUser('firebase-uid-001')).rejects.toThrow(
        new BadRequestException('User is already active'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // createAdminUser
  //
  // The invite email is the ONLY way into an account this creates — the
  // password it sets is random and nobody holds it. So the invite is not a
  // nice-to-have side effect: if it does not go out, the account is dead.
  // -------------------------------------------------------------------------

  describe('createAdminUser', () => {
    const adminInput = {
      email: 'newadmin@lalaba.test',
      firstName: 'New',
      lastName: 'Admin',
      phoneNumber: '09171234567',
      role: 'support',
    };

    let mockCreateUser: jest.Mock;
    let mockDeleteUser: jest.Mock;

    beforeEach(() => {
      mockCreateUser = jest
        .fn()
        .mockImplementation(({ email }: { email: string }) =>
          Promise.resolve({ uid: `fb-${email}` }),
        );
      mockDeleteUser = jest.fn().mockResolvedValue(undefined);
      mockFirebaseService.getAuth.mockReturnValue({
        verifyIdToken: mockVerifyIdToken,
        createUser: mockCreateUser,
        deleteUser: mockDeleteUser,
      });
    });

    it('[HP] sends the set-your-password invite for the new account', async () => {
      await seedRole('support');

      const user = await service.createAdminUser(adminInput);

      expect(user.email).toBe('newadmin@lalaba.test');
      expect(mockSendPasswordResetEmail).toHaveBeenCalledWith(
        'newadmin@lalaba.test',
      );
    });

    it('[SEC] the temporary password is long and never repeats between accounts', async () => {
      await seedRole('support');

      await service.createAdminUser(adminInput);
      await service.createAdminUser({
        ...adminInput,
        email: 'second@lalaba.test',
      });

      const [first, second] = mockCreateUser.mock.calls.map(
        (c) => c[0].password as string,
      );
      // Math.random()-derived passwords were ~22 chars from a predictable
      // stream. randomBytes(24) base64url is 32.
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(second.length).toBeGreaterThanOrEqual(32);
      expect(first).not.toEqual(second);
    });

    it('[EC] a failed invite rolls back BOTH the Firebase user and the Mongo document', async () => {
      await seedRole('support');
      mockSendPasswordResetEmail.mockRejectedValue(
        new Error('email service down'),
      );

      await expect(
        service.createAdminUser(adminInput as any),
      ).rejects.toThrow();

      // Firebase side undone...
      expect(mockDeleteUser).toHaveBeenCalledWith('fb-newadmin@lalaba.test');
      // ...and the Mongo side too. Leaving this behind would make the email
      // read as taken while no credential exists for it, and a retry would
      // hit a duplicate key instead of recreating the account.
      const stranded = await service.findOneById('fb-newadmin@lalaba.test');
      expect(stranded).toBeNull();
    });

    it('[EC] a retry after a failed invite succeeds rather than hitting a duplicate', async () => {
      await seedRole('support');
      mockSendPasswordResetEmail.mockRejectedValueOnce(
        new Error('email service down'),
      );

      await expect(
        service.createAdminUser(adminInput as any),
      ).rejects.toThrow();

      const retried = await service.createAdminUser(adminInput);
      expect(retried.email).toBe('newadmin@lalaba.test');
    });
  });
});
