import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { Branch, BranchSchema } from './schemas/branch.schema';
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
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const makeBranchInput = (overrides: Record<string, any> = {}) => ({
  branchName: 'Main Branch',
  branchPhoneNumber: '09171234567',
  branchAddress: {
    regionName: 'NCR',
    provinceName: 'Metro Manila',
    cityMunicipalityName: 'Makati',
    barangayName: 'Bel-Air',
    streetAddress: '123 Test St',
  },
  branchMapLocation: {
    latitude: 14.5547,
    longitude: 121.0244,
  },
  operatingHours: makeOperatingHours(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('BranchesService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: BranchesService;
  let module: TestingModule;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Branch.name, schema: BranchSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletLedgerEntry.name, schema: WalletLedgerEntrySchema },
          { name: TopUpIntent.name, schema: TopUpIntentSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
        ]),
      ],
      providers: [
        BranchesService,
        WalletsService,
        { provide: PaymentGatewayService, useClass: DevPaymentGateway },
      ],
    }).compile();

    service = module.get<BranchesService>(BranchesService);
    mongoConnection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await module.close();
    await mongod.stop();
  });

  afterEach(async () => {
    const collections = mongoConnection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('[HP] should create a single branch and persist it to the database', async () => {
      const uid = 'user-001';
      const [branch] = await service.create(makeBranchInput(), uid);

      expect(branch).toBeDefined();
      expect(branch.branchName).toBe('Main Branch');
      expect(branch.uid).toBe(uid);
      expect(branch.isActive).toBe(true);
      expect(branch.isOnline).toBe(true);
    });

    it('[HP] should create multiple branches in one call using an array', async () => {
      const uid = 'user-002';
      const branches = await service.create(
        [
          makeBranchInput({ branchName: 'Branch A' }),
          makeBranchInput({ branchName: 'Branch B' }),
        ],
        uid,
      );

      expect(branches).toHaveLength(2);
      expect(branches.map((b) => b.branchName)).toEqual(
        expect.arrayContaining(['Branch A', 'Branch B']),
      );
      branches.forEach((b) => expect(b.uid).toBe(uid));
    });

    it('[HP] should attach the caller uid to every created branch regardless of input', async () => {
      const uid = 'owner-xyz';
      const [branch] = await service.create(makeBranchInput(), uid);
      expect(branch.uid).toBe(uid);
    });
  });

  // -------------------------------------------------------------------------
  // findAllByMerchant
  // -------------------------------------------------------------------------

  describe('findAllByMerchant', () => {
    it('[HP] should return paginated result with correct shape', async () => {
      const uid = 'merchant-1';
      await service.create(makeBranchInput({ branchName: 'Alpha' }), uid);
      await service.create(makeBranchInput({ branchName: 'Beta' }), uid);

      const result = await service.findAllByMerchant(uid);

      expect(result).toMatchObject({ total: 2, limit: 10, offset: 0 });
      expect(result.data).toHaveLength(2);
    });

    it('[HP] should only return branches that belong to the requesting merchant', async () => {
      const uid1 = 'merchant-A';
      const uid2 = 'merchant-B';
      await service.create(makeBranchInput({ branchName: 'A Branch' }), uid1);
      await service.create(makeBranchInput({ branchName: 'B Branch' }), uid2);

      const result = await service.findAllByMerchant(uid1);

      expect(result.total).toBe(1);
      expect(result.data[0].branchName).toBe('A Branch');
    });

    it('[HP] should filter by isActive=false and exclude active branches', async () => {
      const uid = 'merchant-filter';
      const [branch] = await service.create(
        makeBranchInput({ branchName: 'Active One' }),
        uid,
      );
      await service.archive(String(branch._id), uid);
      await service.create(
        makeBranchInput({ branchName: 'Still Active' }),
        uid,
      );

      const result = await service.findAllByMerchant(uid, { isActive: false });

      expect(result.total).toBe(1);
      expect(result.data[0].branchName).toBe('Active One');
    });

    it('[HP] should perform case-insensitive partial name search', async () => {
      const uid = 'merchant-search';
      await service.create(
        makeBranchInput({ branchName: 'Northside Hub' }),
        uid,
      );
      await service.create(
        makeBranchInput({ branchName: 'Southside Hub' }),
        uid,
      );

      const result = await service.findAllByMerchant(uid, { search: 'NORTH' });

      expect(result.total).toBe(1);
      expect(result.data[0].branchName).toBe('Northside Hub');
    });

    it('[HP] should respect limit and offset for pagination', async () => {
      const uid = 'merchant-page';
      for (let i = 1; i <= 5; i++) {
        await service.create(
          makeBranchInput({ branchName: `Branch ${i}` }),
          uid,
        );
      }

      const result = await service.findAllByMerchant(uid, {
        limit: 2,
        offset: 2,
      });

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(2);
    });

    it('[HP] should return empty data array when merchant has no branches', async () => {
      const result = await service.findAllByMerchant('ghost-merchant');
      expect(result.total).toBe(0);
      expect(result.data).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // findById
  // -------------------------------------------------------------------------

  describe('findById', () => {
    it('[HP] should return the branch when id and uid match', async () => {
      const uid = 'owner-find';
      const [branch] = await service.create(
        makeBranchInput({ branchName: 'Find Me' }),
        uid,
      );
      const found = await service.findById(String(branch._id), uid);

      expect(found.branchName).toBe('Find Me');
      expect(found.uid).toBe(uid);
    });

    it('[EC] should throw NotFoundException when branch id does not exist', async () => {
      const nonExistentId = new Types.ObjectId().toHexString();
      await expect(service.findById(nonExistentId, 'any-uid')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('[EC] should throw NotFoundException when uid does not match the branch owner', async () => {
      const uid = 'real-owner';
      const [branch] = await service.create(makeBranchInput(), uid);

      await expect(
        service.findById(String(branch._id), 'impostor-uid'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  describe('update', () => {
    it('[HP] should update branch fields and return the updated document', async () => {
      const uid = 'owner-update';
      const [branch] = await service.create(
        makeBranchInput({ branchName: 'Old Name' }),
        uid,
      );

      const updated = await service.update(String(branch._id), uid, {
        branchName: 'New Name',
      });

      expect(updated.branchName).toBe('New Name');
    });

    it('[EC] should throw NotFoundException when updating a non-existent branch', async () => {
      const nonExistentId = new Types.ObjectId().toHexString();
      await expect(
        service.update(nonExistentId, 'any-uid', { branchName: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('[EC] should throw NotFoundException when uid does not match the branch owner on update', async () => {
      const uid = 'real-owner';
      const [branch] = await service.create(makeBranchInput(), uid);

      await expect(
        service.update(String(branch._id), 'wrong-owner', {
          branchName: 'Hack',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // archive
  // -------------------------------------------------------------------------

  describe('archive', () => {
    it('[HP] should set isActive to false on an active branch', async () => {
      const uid = 'owner-archive';
      const [branch] = await service.create(makeBranchInput(), uid);

      const archived = await service.archive(String(branch._id), uid);

      expect(archived.isActive).toBe(false);
    });

    it('[EC] should throw NotFoundException when archiving a non-existent branch', async () => {
      const nonExistentId = new Types.ObjectId().toHexString();
      await expect(service.archive(nonExistentId, 'any-uid')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('[EC] should throw NotFoundException when uid does not match branch owner on archive', async () => {
      const uid = 'real-owner';
      const [branch] = await service.create(makeBranchInput(), uid);

      await expect(
        service.archive(String(branch._id), 'wrong-owner'),
      ).rejects.toThrow(NotFoundException);
    });

    it('[EC] should throw BadRequestException with message "Branch is already archived" when already inactive', async () => {
      const uid = 'owner-double-archive';
      const [branch] = await service.create(makeBranchInput(), uid);
      await service.archive(String(branch._id), uid);

      await expect(service.archive(String(branch._id), uid)).rejects.toThrow(
        new BadRequestException('Branch is already archived'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // restore
  // -------------------------------------------------------------------------

  describe('restore', () => {
    it('[HP] should set isActive to true on an archived branch', async () => {
      const uid = 'owner-restore';
      const [branch] = await service.create(makeBranchInput(), uid);
      await service.archive(String(branch._id), uid);

      const restored = await service.restore(String(branch._id), uid);

      expect(restored.isActive).toBe(true);
    });

    it('[EC] should throw NotFoundException when restoring a non-existent branch', async () => {
      const nonExistentId = new Types.ObjectId().toHexString();
      await expect(service.restore(nonExistentId, 'any-uid')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('[EC] should throw NotFoundException when uid does not match branch owner on restore', async () => {
      const uid = 'real-owner';
      const [branch] = await service.create(makeBranchInput(), uid);
      await service.archive(String(branch._id), uid);

      await expect(
        service.restore(String(branch._id), 'wrong-owner'),
      ).rejects.toThrow(NotFoundException);
    });

    it('[EC] should throw BadRequestException with message "Branch is already active" when already active', async () => {
      const uid = 'owner-double-restore';
      const [branch] = await service.create(makeBranchInput(), uid);

      await expect(service.restore(String(branch._id), uid)).rejects.toThrow(
        new BadRequestException('Branch is already active'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // setOnline
  // -------------------------------------------------------------------------

  describe('setOnline', () => {
    it('[HP] should set isOnline to false', async () => {
      const uid = 'owner-offline';
      const [branch] = await service.create(makeBranchInput(), uid);
      expect(branch.isOnline).toBe(true);

      const updated = await service.setOnline(String(branch._id), uid, false);

      expect(updated.isOnline).toBe(false);
    });

    it('[HP] should set isOnline back to true', async () => {
      const uid = 'owner-online';
      const [branch] = await service.create(makeBranchInput(), uid);
      await service.setOnline(String(branch._id), uid, false);

      const updated = await service.setOnline(String(branch._id), uid, true);

      expect(updated.isOnline).toBe(true);
    });

    it('[EC] should throw NotFoundException for a non-existent branch', async () => {
      const nonExistentId = new Types.ObjectId().toHexString();
      await expect(
        service.setOnline(nonExistentId, 'any-uid', true),
      ).rejects.toThrow(NotFoundException);
    });

    it('[EC] should throw NotFoundException when uid does not match branch owner', async () => {
      const uid = 'real-owner';
      const [branch] = await service.create(makeBranchInput(), uid);

      await expect(
        service.setOnline(String(branch._id), 'wrong-owner', true),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
