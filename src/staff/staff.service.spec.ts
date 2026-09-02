// Mock Branch schema BEFORE any imports that reference it
jest.mock('../branches/schemas/branch.schema', () => ({
  Branch: class Branch {},
  BranchSchema: require('mongoose').Schema(
    {
      uid: String,
      branchName: { type: String, required: true },
      isActive: { type: Boolean, default: true },
    },
    { timestamps: true },
  ),
}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

import { StaffService } from './staff.service';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { PERMISSION_CATALOGUE } from '../permissions/permission-catalogue';
import { PERMISSION_GROUP_MEMBERS } from '../permissions/permission-groups';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import { FirebaseService } from '../firebase/firebase.service';
import { EmailService } from '../email/email.service';

// ─── Firebase / Cache mocks ───────────────────────────────────────────────────

const mockFirebaseAuth = {
  createUser: jest.fn().mockResolvedValue({ uid: 'firebase-staff-001' }),
  deleteUser: jest.fn().mockResolvedValue(undefined),
  generatePasswordResetLink: jest
    .fn()
    .mockResolvedValue('https://reset.link/token'),
};

const mockFirebaseService = {
  getAuth: jest.fn().mockReturnValue(mockFirebaseAuth),
};

const mockCacheManager = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
};

const mockEmailService = {
  sendStaffInvite: jest.fn().mockResolvedValue(undefined),
};

// ─── Test-wide constants ──────────────────────────────────────────────────────

const MERCHANT_ID = 'merchant-firebase-uid-001';

// ─── Infrastructure ───────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let mongoConnection: Connection;
let testingModule: TestingModule;
let service: StaffService;
let userModel: Model<any>;
let roleModel: Model<any>;
let branchModel: Model<any>;
let permissionModel: Model<any>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  testingModule = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(uri),
      MongooseModule.forFeature([
        { name: User.name, schema: UserSchema },
        { name: Role.name, schema: RoleSchema },
        { name: Branch.name, schema: BranchSchema },
        { name: Permission.name, schema: PermissionSchema },
      ]),
    ],
    providers: [
      StaffService,
      { provide: FirebaseService, useValue: mockFirebaseService },
      { provide: EmailService, useValue: mockEmailService },
      { provide: CACHE_MANAGER, useValue: mockCacheManager },
    ],
  }).compile();

  service = testingModule.get<StaffService>(StaffService);
  mongoConnection = testingModule.get<Connection>(getConnectionToken());
  userModel = testingModule.get(getModelToken(User.name));
  roleModel = testingModule.get(getModelToken(Role.name));
  branchModel = testingModule.get(getModelToken(Branch.name));
  permissionModel = testingModule.get(getModelToken(Permission.name));
});

afterAll(async () => {
  await mongoConnection.dropDatabase();
  await testingModule.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = mongoConnection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
  jest.clearAllMocks();

  // Re-apply default mock implementations after clearAllMocks wipes them
  mockFirebaseAuth.createUser.mockResolvedValue({ uid: 'firebase-staff-001' });
  mockFirebaseAuth.deleteUser.mockResolvedValue(undefined);
  mockFirebaseAuth.generatePasswordResetLink.mockResolvedValue(
    'https://reset.link/token',
  );
  mockFirebaseService.getAuth.mockReturnValue(mockFirebaseAuth);
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeStaffInput(overrides: Record<string, any> = {}) {
  return {
    email: 'staff@example.com',
    firstName: 'Maria',
    lastName: 'Santos',
    phoneNumber: '09171234567',
    password: 'Password123!',
    branchIds: [],
    ...overrides,
  };
}

async function seedStaffRole(): Promise<any> {
  return roleModel.create({
    roleId: 'staff',
    roleName: 'Staff',
    description: 'Staff member',
  });
}

async function seedStaffUser(
  overrides: Record<string, any> = {},
): Promise<any> {
  const role = await seedStaffRole();
  const defaults = {
    _id: 'staff-firebase-uid-001',
    email: 'staff@example.com',
    firstName: 'Maria',
    lastName: 'Santos',
    phoneNumber: '09171234567',
    role: role._id,
    merchantId: MERCHANT_ID,
    branchIds: [],
    isActive: true,
    isArchived: false,
  };
  return userModel.create({ ...defaults, ...overrides });
}

async function seedBranch(overrides: Record<string, any> = {}): Promise<any> {
  const defaults = {
    uid: MERCHANT_ID,
    branchName: 'Main Branch',
    isActive: true,
  };
  return branchModel.create({ ...defaults, ...overrides });
}

// ═════════════════════════════════════════════════════════════════════════════
// createStaff
// ═════════════════════════════════════════════════════════════════════════════

describe('createStaff — who may invite whom', () => {
  // A home washer has no shop floor and no POS, so a 'staff' account would be
  // provisioned onto screens that do not apply to her. Enforced server-side
  // because the mutation is shared with merchants — only the CALLER's role
  // decides what is allowed, and the input looks identical either way.
  it('[SEC] rejects a washer inviting staff', async () => {
    await seedStaffRole();
    await expect(
      service.createStaff(makeStaffInput(), MERCHANT_ID, 'washer'),
    ).rejects.toThrow(/only invite couriers/i);
  });

  it('[SEC] rejects a washer defaulting the role (default is staff)', async () => {
    await seedStaffRole();
    const input = makeStaffInput();
    delete (input as Record<string, unknown>).role;
    await expect(
      service.createStaff(input, MERCHANT_ID, 'washer'),
    ).rejects.toThrow(/only invite couriers/i);
  });

  it('[HP] allows a washer inviting a courier', async () => {
    await roleModel.create({
      roleId: 'courier',
      roleName: 'Courier',
      description: 'Courier',
    });
    const result = await service.createStaff(
      makeStaffInput({ role: 'courier' }),
      MERCHANT_ID,
      'washer',
    );
    expect(result.merchantId).toBe(MERCHANT_ID);
  });

  it('[HP] a merchant may still invite staff', async () => {
    await seedStaffRole();
    const result = await service.createStaff(
      makeStaffInput(),
      MERCHANT_ID,
      'merchant',
    );
    expect(result.merchantId).toBe(MERCHANT_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Per-branch grants
// ═════════════════════════════════════════════════════════════════════════════

async function seedCatalogue(): Promise<Map<string, string>> {
  const rows = await permissionModel.insertMany(
    PERMISSION_CATALOGUE.map((p) => ({
      permissionName: p.permissionName,
      description: p.description,
    })),
  );
  return new Map(rows.map((r: any) => [r.permissionName, String(r._id)]));
}

describe('createStaff — per-branch grants', () => {
  it('[HP] expands owner-chosen groups into the permissions they stand for', async () => {
    await seedStaffRole();
    const byName = await seedCatalogue();
    const branch = await seedBranch();

    const created = await service.createStaff(
      makeStaffInput({
        branchAccess: [{ branchId: String(branch._id), groups: ['SERVICES'] }],
      }),
      MERCHANT_ID,
      'merchant',
    );

    const stored = await userModel.findById(created._id).lean();
    const granted = stored.branchAccess[0].permissionIds.map(String).sort();
    expect(granted).toEqual(
      PERMISSION_GROUP_MEMBERS.SERVICES.map((n) => byName.get(n)!).sort(),
    );
    // The owner never sees permission names — the read path answers in groups.
    expect(created.branchAccess).toEqual([
      { branchId: String(branch._id), groups: ['SERVICES'] },
    ]);
  });

  it('[HP] grants different access on different branches', async () => {
    await seedStaffRole();
    await seedCatalogue();
    const makati = await seedBranch({ branchName: 'Makati' });
    const bgc = await seedBranch({ branchName: 'BGC' });

    const created = await service.createStaff(
      makeStaffInput({
        branchAccess: [
          { branchId: String(makati._id), groups: ['ORDERS', 'INVENTORY'] },
          { branchId: String(bgc._id), groups: ['SERVICES'] },
        ],
      }),
      MERCHANT_ID,
      'merchant',
    );

    expect(created.branchAccess).toEqual([
      { branchId: String(makati._id), groups: ['ORDERS', 'INVENTORY'] },
      { branchId: String(bgc._id), groups: ['SERVICES'] },
    ]);
  });

  it('[HP] mirrors branchIds and the permissionIds union off branchAccess', async () => {
    await seedStaffRole();
    await seedCatalogue();
    const makati = await seedBranch({ branchName: 'Makati' });
    const bgc = await seedBranch({ branchName: 'BGC' });

    const created = await service.createStaff(
      makeStaffInput({
        branchAccess: [
          { branchId: String(makati._id), groups: ['ORDERS'] },
          { branchId: String(bgc._id), groups: ['SERVICES'] },
        ],
      }),
      MERCHANT_ID,
      'merchant',
    );

    const stored = await userModel.findById(created._id).lean();
    expect(stored.branchIds.map(String).sort()).toEqual(
      [String(makati._id), String(bgc._id)].sort(),
    );
    expect(stored.permissionIds).toHaveLength(
      PERMISSION_GROUP_MEMBERS.ORDERS.length +
        PERMISSION_GROUP_MEMBERS.SERVICES.length,
    );
  });

  it('[SEC] refuses to grant a courier permissions', async () => {
    await roleModel.create({
      roleId: 'courier',
      roleName: 'Courier',
      description: 'Courier',
    });
    await seedCatalogue();
    const branch = await seedBranch();

    await expect(
      service.createStaff(
        makeStaffInput({
          role: 'courier',
          branchAccess: [{ branchId: String(branch._id), groups: ['ORDERS'] }],
        }) as any,
        MERCHANT_ID,
        'merchant',
      ),
    ).rejects.toThrow(/pickup and delivery/i);
  });

  it('[HP] a courier is assigned to branches but granted nothing', async () => {
    await roleModel.create({
      roleId: 'courier',
      roleName: 'Courier',
      description: 'Courier',
    });
    await seedCatalogue();
    const branch = await seedBranch();

    const created = await service.createStaff(
      makeStaffInput({
        role: 'courier',
        branchAccess: [{ branchId: String(branch._id), groups: [] }],
      }),
      MERCHANT_ID,
      'merchant',
    );

    const stored = await userModel.findById(created._id).lean();
    expect(stored.branchIds.map(String)).toEqual([String(branch._id)]);
    expect(stored.permissionIds).toEqual([]);
  });

  it('[SEC] rejects a branch belonging to another merchant', async () => {
    await seedStaffRole();
    await seedCatalogue();
    const foreign = await seedBranch({ uid: 'someone-else' });

    await expect(
      service.createStaff(
        makeStaffInput({
          branchAccess: [{ branchId: String(foreign._id), groups: ['ORDERS'] }],
        }) as any,
        MERCHANT_ID,
        'merchant',
      ),
    ).rejects.toThrow(/do not belong to you/i);
  });
});

describe('updateStaff — per-branch grants', () => {
  it('[HP] branchAccess replaces the stored grants', async () => {
    const byName = await seedCatalogue();
    const branch = await seedBranch();
    const staff = await seedStaffUser({
      branchAccess: [
        {
          branchId: branch._id,
          permissionIds: [byName.get('order_create')],
        },
      ],
      branchIds: [branch._id],
    });

    const updated = await service.updateStaff(staff._id, MERCHANT_ID, {
      branchAccess: [{ branchId: String(branch._id), groups: ['SERVICES'] }],
    } as any);

    expect(updated.branchAccess).toEqual([
      { branchId: String(branch._id), groups: ['SERVICES'] },
    ]);
  });

  it('[COMPAT] a legacy permissionIds update applies to every branch', async () => {
    // Pre-rollout app builds send one account-global list. Reproducing what it
    // used to mean is the only safe reading.
    const byName = await seedCatalogue();
    const makati = await seedBranch({ branchName: 'Makati' });
    const bgc = await seedBranch({ branchName: 'BGC' });
    const staff = await seedStaffUser({
      branchAccess: [
        { branchId: makati._id, permissionIds: [] },
        { branchId: bgc._id, permissionIds: [] },
      ],
      branchIds: [makati._id, bgc._id],
    });

    await service.updateStaff(staff._id, MERCHANT_ID, {
      permissionIds: [byName.get('order_create')!],
    });

    const stored = await userModel.findById(staff._id).lean();
    expect(stored.branchAccess).toHaveLength(2);
    for (const entry of stored.branchAccess) {
      expect(entry.permissionIds.map(String)).toEqual([
        byName.get('order_create'),
      ]);
    }
  });

  it('[COMPAT] a legacy branchIds-only update keeps existing grants and does not wipe them', async () => {
    // The old app sends branchIds alone when reassigning branches. Deriving
    // from scratch here would silently drop every permission the owner set.
    const byName = await seedCatalogue();
    const makati = await seedBranch({ branchName: 'Makati' });
    const bgc = await seedBranch({ branchName: 'BGC' });
    const staff = await seedStaffUser({
      branchAccess: [
        {
          branchId: makati._id,
          permissionIds: [byName.get('order_create')],
        },
      ],
      branchIds: [makati._id],
    });

    await service.updateStaff(staff._id, MERCHANT_ID, {
      branchIds: [String(makati._id), String(bgc._id)],
    });

    const stored = await userModel.findById(staff._id).lean();
    const kept = stored.branchAccess.find(
      (e: any) => String(e.branchId) === String(makati._id),
    );
    const added = stored.branchAccess.find(
      (e: any) => String(e.branchId) === String(bgc._id),
    );
    expect(kept.permissionIds.map(String)).toEqual([
      byName.get('order_create'),
    ]);
    expect(added.permissionIds).toEqual([]);
  });

  it('[SEC] never writes the grant fields straight off the input', async () => {
    const byName = await seedCatalogue();
    const branch = await seedBranch();
    const staff = await seedStaffUser({
      branchAccess: [{ branchId: branch._id, permissionIds: [] }],
      branchIds: [branch._id],
    });

    // A client sending branchAccess AND a contradictory permissionIds must not
    // get the raw list through — branchAccess wins and the mirrors are derived.
    await service.updateStaff(staff._id, MERCHANT_ID, {
      branchAccess: [{ branchId: String(branch._id), groups: ['SERVICES'] }],
      permissionIds: [byName.get('order_cancel')!],
    } as any);

    const stored = await userModel.findById(staff._id).lean();
    const names = PERMISSION_GROUP_MEMBERS.SERVICES.map((n) => byName.get(n)!);
    expect(stored.permissionIds.map(String).sort()).toEqual(names.sort());
    expect(stored.permissionIds.map(String)).not.toContain(
      byName.get('order_cancel'),
    );
  });
});

describe('createStaff', () => {
  it('[HP] creates Firebase user then MongoDB user with correct fields', async () => {
    const role = await seedStaffRole();
    const input = makeStaffInput();

    const result = await service.createStaff(input, MERCHANT_ID);

    // Firebase was called with the right args. The password is deliberately
    // NOT the one in the fixture: createStaff generates a random throwaway and
    // emails a reset link, so the owner never chooses (or learns) their staff
    // member's password. Asserting equality with a caller-supplied value
    // described the opposite of the intended behaviour.
    expect(mockFirebaseAuth.createUser).toHaveBeenCalledWith({
      email: input.email,
      password: expect.any(String),
      displayName: 'Maria Santos',
      disabled: false,
    });
    const { password: usedPassword } = mockFirebaseAuth.createUser.mock
      .calls[0][0] as { password: string };
    expect(usedPassword).not.toBe(input.password);
    expect(usedPassword.length).toBeGreaterThanOrEqual(12);

    // Mongo document has correct fields
    expect(result._id).toBe('firebase-staff-001');
    expect(result.email).toBe(input.email);
    expect(result.firstName).toBe(input.firstName);
    expect(result.lastName).toBe(input.lastName);
    expect(result.phoneNumber).toBe(input.phoneNumber);
    expect(result.merchantId).toBe(MERCHANT_ID);
    expect(result.isActive).toBe(true);
    expect(result.isArchived).toBe(false);

    // role field is populated (object with roleId) or stored as the role _id
    const roleField = (result as any).role;
    const roleId = roleField?._id?.toString() ?? roleField?.toString();
    expect(roleId).toBe(role._id.toString());
  });

  it('[HP] createStaff with valid branchIds sets branchIds as ObjectIds', async () => {
    await seedStaffRole();
    const branch = await seedBranch();
    const input = makeStaffInput({ branchIds: [branch._id.toString()] });

    const result = await service.createStaff(input, MERCHANT_ID);

    expect(Array.isArray(result.branchIds)).toBe(true);
    expect(result.branchIds).toHaveLength(1);
    expect(result.branchIds![0].toString()).toBe(branch._id.toString());
  });

  it('[EC] no staff role in DB → BadRequestException', async () => {
    // roleModel is empty — no staff role seeded
    await expect(
      service.createStaff(makeStaffInput() as any, MERCHANT_ID),
    ).rejects.toThrow(
      new BadRequestException(
        'Unable to create staff account. Please try again.',
      ),
    );
  });

  it('[EC] Firebase createUser throws auth/email-already-exists → ConflictException', async () => {
    await seedStaffRole();
    const firebaseError = Object.assign(new Error('email already exists'), {
      code: 'auth/email-already-exists',
    });
    mockFirebaseAuth.createUser.mockRejectedValueOnce(firebaseError);

    await expect(
      service.createStaff(makeStaffInput() as any, MERCHANT_ID),
    ).rejects.toThrow(
      new ConflictException('A user with this email already exists'),
    );
  });

  it('[EC] Firebase createUser throws a generic error → BadRequestException', async () => {
    await seedStaffRole();
    mockFirebaseAuth.createUser.mockRejectedValueOnce(
      new Error('network error'),
    );

    await expect(
      service.createStaff(makeStaffInput() as any, MERCHANT_ID),
    ).rejects.toThrow(
      new BadRequestException('Account creation failed. Please try again.'),
    );
  });

  it('[EC] MongoDB save fails → rolls back Firebase user (deleteUser called with firebaseUid)', async () => {
    await seedStaffRole();
    const saveSpy = jest
      .spyOn(userModel.prototype, 'save')
      .mockRejectedValueOnce(new Error('DB write failed'));

    await expect(
      service.createStaff(makeStaffInput() as any, MERCHANT_ID),
    ).rejects.toThrow('DB write failed');

    expect(mockFirebaseAuth.deleteUser).toHaveBeenCalledWith(
      'firebase-staff-001',
    );

    saveSpy.mockRestore();
  });

  it('[EC] branchId belongs to a different merchant → BadRequestException from validateBranches', async () => {
    await seedStaffRole();
    const branch = await seedBranch({ uid: 'other-merchant-uid' }); // wrong owner
    const input = makeStaffInput({ branchIds: [branch._id.toString()] });

    await expect(
      service.createStaff(input as any, MERCHANT_ID),
    ).rejects.toThrow(
      new BadRequestException(
        'One or more branches do not belong to you or are not active',
      ),
    );
  });

  it('[EC] branch is inactive → BadRequestException from validateBranches', async () => {
    await seedStaffRole();
    const branch = await seedBranch({ isActive: false }); // inactive
    const input = makeStaffInput({ branchIds: [branch._id.toString()] });

    await expect(
      service.createStaff(input as any, MERCHANT_ID),
    ).rejects.toThrow(
      new BadRequestException(
        'One or more branches do not belong to you or are not active',
      ),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findAllByMerchant
// ═════════════════════════════════════════════════════════════════════════════

describe('findAllByMerchant', () => {
  it('[HP] returns paginated staff list for the merchant', async () => {
    await seedStaffUser();
    // Seed a second staff under a different merchant — should not appear
    const otherRole = await roleModel.create({
      roleId: 'staff2',
      roleName: 'Staff',
      description: 'Other',
    });
    await userModel.create({
      _id: 'other-staff-uid',
      email: 'other@example.com',
      firstName: 'Other',
      lastName: 'Person',
      phoneNumber: '09181234567',
      role: otherRole._id,
      merchantId: 'different-merchant',
      branchIds: [],
      isActive: true,
      isArchived: false,
    });

    const result = await service.findAllByMerchant(MERCHANT_ID);

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect((result.data[0] as any).merchantId).toBe(MERCHANT_ID);
  });

  it('[HP] search filter matches firstName case-insensitively', async () => {
    await seedStaffUser({
      firstName: 'Maria',
      lastName: 'Santos',
      email: 'maria@example.com',
    });

    const result = await service.findAllByMerchant(MERCHANT_ID, {
      search: 'maria',
    });

    expect(result.total).toBe(1);
    expect((result.data[0] as any).firstName).toBe('Maria');
  });

  it('[HP] branchId filter only returns staff assigned to that branch', async () => {
    const branch = await seedBranch();
    const branchIdObj = branch._id;

    const role = await seedStaffRole();
    // Staff WITH the branch
    await userModel.create({
      _id: 'staff-with-branch',
      email: 'withbranch@example.com',
      firstName: 'Ana',
      lastName: 'Reyes',
      phoneNumber: '09171112222',
      role: role._id,
      merchantId: MERCHANT_ID,
      branchIds: [branchIdObj],
      isActive: true,
      isArchived: false,
    });
    // Staff WITHOUT the branch
    await userModel.create({
      _id: 'staff-no-branch',
      email: 'nobranch@example.com',
      firstName: 'Ben',
      lastName: 'Cruz',
      phoneNumber: '09173334444',
      role: role._id,
      merchantId: MERCHANT_ID,
      branchIds: [],
      isActive: true,
      isArchived: false,
    });

    const result = await service.findAllByMerchant(MERCHANT_ID, {
      branchId: branchIdObj.toString(),
    });

    expect(result.total).toBe(1);
    expect((result.data[0] as any)._id).toBe('staff-with-branch');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findById
// ═════════════════════════════════════════════════════════════════════════════

describe('findById', () => {
  it('[HP] returns staff with populated role when found', async () => {
    const staff = await seedStaffUser();

    const result = await service.findById(
      'staff-firebase-uid-001',
      MERCHANT_ID,
    );

    expect((result as any)._id).toBe('staff-firebase-uid-001');
    // role should be populated (object) rather than a raw ObjectId
    expect(typeof (result as any).role).toBe('object');
    expect((result as any).role).not.toBeNull();
  });

  it('[EC] wrong merchantId → NotFoundException', async () => {
    await seedStaffUser();

    await expect(
      service.findById('staff-firebase-uid-001', 'wrong-merchant'),
    ).rejects.toThrow(new NotFoundException('Staff not found'));
  });

  it('[EC] non-existent id → NotFoundException', async () => {
    await expect(
      service.findById('does-not-exist', MERCHANT_ID),
    ).rejects.toThrow(new NotFoundException('Staff not found'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// updateStaff
// ═════════════════════════════════════════════════════════════════════════════

describe('updateStaff', () => {
  it('[HP] updates firstName and invalidates cache', async () => {
    await seedStaffUser();

    const result = await service.updateStaff(
      'staff-firebase-uid-001',
      MERCHANT_ID,
      { firstName: 'Maricel' },
    );

    expect((result as any).firstName).toBe('Maricel');
    expect(mockCacheManager.del).toHaveBeenCalledWith(
      'user:staff-firebase-uid-001',
    );
  });

  it('[HP] updates branchIds and stores them as ObjectIds', async () => {
    await seedStaffUser();
    const branch = await seedBranch();

    await service.updateStaff('staff-firebase-uid-001', MERCHANT_ID, {
      branchIds: [branch._id.toString()],
    });

    const updated = await userModel
      .findById('staff-firebase-uid-001')
      .lean()
      .exec();
    expect(updated!.branchIds).toHaveLength(1);
    expect(updated!.branchIds[0].toString()).toBe(branch._id.toString());
  });

  it('[EC] staff not found → NotFoundException', async () => {
    await expect(
      service.updateStaff('does-not-exist', MERCHANT_ID, {
        firstName: 'X',
      } as any),
    ).rejects.toThrow(new NotFoundException('Staff not found'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// archiveStaff
// ═════════════════════════════════════════════════════════════════════════════

describe('archiveStaff', () => {
  it('[HP] sets isArchived=true and invalidates cache', async () => {
    await seedStaffUser({ isArchived: false });

    const result = await service.archiveStaff(
      'staff-firebase-uid-001',
      MERCHANT_ID,
    );

    expect((result as any).isArchived).toBe(true);
    expect(mockCacheManager.del).toHaveBeenCalledWith(
      'user:staff-firebase-uid-001',
    );
  });

  it('[HP] already archived → returns staff without throwing (idempotent)', async () => {
    await seedStaffUser({ isArchived: true });

    const result = await service.archiveStaff(
      'staff-firebase-uid-001',
      MERCHANT_ID,
    );

    expect((result as any).isArchived).toBe(true);
    // cache.del should NOT be called because we return early
    expect(mockCacheManager.del).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// restoreStaff
// ═════════════════════════════════════════════════════════════════════════════

describe('restoreStaff', () => {
  it('[HP] sets isArchived=false and invalidates cache', async () => {
    await seedStaffUser({ isArchived: true });

    const result = await service.restoreStaff(
      'staff-firebase-uid-001',
      MERCHANT_ID,
    );

    expect((result as any).isArchived).toBe(false);
    expect(mockCacheManager.del).toHaveBeenCalledWith(
      'user:staff-firebase-uid-001',
    );
  });

  it('[HP] already active → returns staff without throwing (idempotent)', async () => {
    await seedStaffUser({ isArchived: false });

    const result = await service.restoreStaff(
      'staff-firebase-uid-001',
      MERCHANT_ID,
    );

    expect((result as any).isArchived).toBe(false);
    // cache.del should NOT be called because we return early
    expect(mockCacheManager.del).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// generatePasswordResetLink
// ═════════════════════════════════════════════════════════════════════════════

describe('generatePasswordResetLink', () => {
  it('[HP] returns the reset link from Firebase', async () => {
    await seedStaffUser({ isArchived: false, email: 'staff@example.com' });

    const link = await service.generatePasswordResetLink(
      'staff-firebase-uid-001',
      MERCHANT_ID,
    );

    expect(link).toBe('https://reset.link/token');
    expect(mockFirebaseAuth.generatePasswordResetLink).toHaveBeenCalledWith(
      'staff@example.com',
    );
  });

  it('[EC] archived staff → BadRequestException', async () => {
    await seedStaffUser({ isArchived: true });

    await expect(
      service.generatePasswordResetLink('staff-firebase-uid-001', MERCHANT_ID),
    ).rejects.toThrow(
      new BadRequestException(
        'Cannot reset password for an archived staff account.',
      ),
    );
  });

  it('[EC] staff not found → NotFoundException', async () => {
    await expect(
      service.generatePasswordResetLink('does-not-exist', MERCHANT_ID),
    ).rejects.toThrow(new NotFoundException('Staff not found'));
  });
});
