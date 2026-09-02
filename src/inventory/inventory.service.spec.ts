jest.mock('../branches/schemas/branch.schema', () => {
  const mongoose = require('mongoose');
  return {
    Branch: class Branch {},
    BranchSchema: new mongoose.Schema(
      {
        uid: { type: String, required: true },
        branchName: { type: String, required: true },
        isActive: { type: Boolean, default: true },
        isOnline: { type: Boolean, default: true },
      },
      { timestamps: true },
    ),
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Connection, Model, Types } from 'mongoose';
import { Inventory, InventorySchema } from './schemas/inventory.schema';
import {
  InventoryTransaction,
  InventoryTransactionSchema,
  TransactionType,
} from './schemas/inventory-transaction.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { Product } from '../products/schemas/product.schema';
import { Service } from '../services/schemas/service.schema';
import { InventoryService } from './inventory.service';

// InventoryService.archive() checks Product/Service usage via countDocuments()
// before allowing an archive — no test here exercises that path, so a plain
// mock (rather than a real in-memory-Mongo model) is enough to satisfy DI.
function makeCountModel() {
  return {
    countDocuments: jest
      .fn()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
  };
}

// ---------------------------------------------------------------------------
// User mock helpers
// ---------------------------------------------------------------------------

const makeMerchantUser = (id = 'merchant-uid-001') =>
  ({
    _id: id,
    role: { roleId: 'merchant' },
    merchantId: undefined,
    branchIds: [],
  }) as any;

const makeStaffUser = (branchIds: string[] = []) =>
  ({
    _id: 'staff-uid-001',
    role: { roleId: 'staff' },
    merchantId: 'merchant-uid-001',
    branchIds,
  }) as any;

// ---------------------------------------------------------------------------
// Inventory fixture helper
// ---------------------------------------------------------------------------

const makeInventoryInput = (overrides: Record<string, any> = {}) => ({
  productName: 'Ariel Powder',
  branchId: 'branch-placeholder', // overridden in most tests
  cost: 25,
  inventoryUnit: 'kg',
  inventoryCategory: 'powdered_detergent',
  stockQuantity: 100,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('InventoryService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: InventoryService;
  let module: TestingModule;
  let inventoryModel: Model<any>;
  let transactionModel: Model<any>;
  let branchModel: Model<any>;

  // Reusable merchant uid
  const MERCHANT_UID = 'merchant-uid-001';

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          {
            name: (Inventory as any).name || 'Inventory',
            schema: InventorySchema,
          },
          {
            name: (InventoryTransaction as any).name || 'InventoryTransaction',
            schema: InventoryTransactionSchema,
          },
          { name: (Branch as any).name || 'Branch', schema: BranchSchema },
        ]),
      ],
      providers: [
        InventoryService,
        { provide: getModelToken(Product.name), useValue: makeCountModel() },
        { provide: getModelToken(Service.name), useValue: makeCountModel() },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
    mongoConnection = module.get<Connection>(getConnectionToken());
    inventoryModel = module.get(
      getModelToken((Inventory as any).name || 'Inventory'),
    );
    transactionModel = module.get(
      getModelToken(
        (InventoryTransaction as any).name || 'InventoryTransaction',
      ),
    );
    branchModel = module.get(getModelToken((Branch as any).name || 'Branch'));
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
  // Helper: insert an active branch owned by MERCHANT_UID
  // -------------------------------------------------------------------------
  async function createActiveBranch(overrides: Record<string, any> = {}) {
    return branchModel.create({
      uid: MERCHANT_UID,
      branchName: 'Test Branch',
      isActive: true,
      isOnline: true,
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // Helper: insert an inventory item directly (bypassing branch validation)
  // -------------------------------------------------------------------------
  async function seedInventory(overrides: Record<string, any> = {}) {
    return inventoryModel.create({
      uid: MERCHANT_UID,
      branchId: 'branch-seed',
      productName: 'Ariel Powder',
      cost: 25,
      inventoryUnit: 'kg',
      inventoryCategory: 'powdered_detergent',
      stockQuantity: 100,
      isActive: true,
      isArchived: false,
      ...overrides,
    });
  }

  // =========================================================================
  // create()
  // =========================================================================

  describe('create()', () => {
    it('EC: throws BadRequestException when branch does not exist', async () => {
      const user = makeMerchantUser();
      const input = makeInventoryInput({
        branchId: new Types.ObjectId().toHexString(),
      });
      await expect(service.create(input as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('EC: throws BadRequestException when branch belongs to a different merchant', async () => {
      const branch = await createActiveBranch({ uid: 'other-merchant' });
      const user = makeMerchantUser(MERCHANT_UID);
      const input = makeInventoryInput({ branchId: branch._id.toString() });
      await expect(service.create(input as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('EC: throws BadRequestException when branch is inactive', async () => {
      const branch = await createActiveBranch({ isActive: false });
      const user = makeMerchantUser();
      const input = makeInventoryInput({ branchId: branch._id.toString() });
      await expect(service.create(input as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('EC: throws BadRequestException when staff user is not assigned to that branch', async () => {
      const branch = await createActiveBranch();
      const branchId = branch._id.toString();
      // Staff assigned to a different branch
      const user = makeStaffUser([new Types.ObjectId().toHexString()]);
      const input = makeInventoryInput({ branchId });
      await expect(service.create(input as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('HP: merchant can create an inventory item for their own active branch', async () => {
      const branch = await createActiveBranch();
      const branchId = branch._id.toString();
      const user = makeMerchantUser();
      const input = makeInventoryInput({ branchId });

      const result = await service.create(input as any, user);

      expect(result).toBeDefined();
      expect(result.productName).toBe('Ariel Powder');
      expect(result.uid).toBe(MERCHANT_UID);
      expect(result.branchId).toBe(branchId);
    });

    it('HP: staff can create when they are assigned to that branch', async () => {
      const branch = await createActiveBranch();
      const branchId = branch._id.toString();
      const user = makeStaffUser([branchId]);
      const input = makeInventoryInput({ branchId });

      const result = await service.create(input as any, user);
      expect(result).toBeDefined();
      expect(result.uid).toBe(MERCHANT_UID); // getMerchantId returns merchantId for staff
    });
  });

  // =========================================================================
  // findAll()
  // =========================================================================

  describe('findAll()', () => {
    it('HP: returns paginated results with total count', async () => {
      await seedInventory({ productName: 'Item A' });
      await seedInventory({ productName: 'Item B' });
      await seedInventory({ productName: 'Item C' });

      const result = await service.findAll(MERCHANT_UID, null, {
        limit: 2,
        offset: 0,
      });
      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(2);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
    });

    it('HP: offset skips the correct number of items', async () => {
      await seedInventory({ productName: 'Item A' });
      await seedInventory({ productName: 'Item B' });
      await seedInventory({ productName: 'Item C' });

      const result = await service.findAll(MERCHANT_UID, null, {
        limit: 10,
        offset: 2,
      });
      expect(result.data).toHaveLength(1);
    });

    it('HP: filters by branchId when provided in filter', async () => {
      await seedInventory({ branchId: 'branch-A', productName: 'In Branch A' });
      await seedInventory({ branchId: 'branch-B', productName: 'In Branch B' });

      const result = await service.findAll(MERCHANT_UID, null, {
        branchId: 'branch-A',
      });
      expect(result.total).toBe(1);
      expect(result.data[0].productName).toBe('In Branch A');
    });

    // =======================================================================
    // SEC-023 — regression: the intra-tenant branch escape.
    //
    // Before the fix, findAll read the caller-supplied branchId FIRST and only
    // fell back to the assignment when none was given:
    //
    //   if (branchId)              query.branchId = branchId;
    //   else if (branchIds.length) query.branchId = { $in: branchIds };
    //
    // so a staff member assigned to branch-A could read branch-B's stock by
    // naming it. These cases fail against that shape and pass against
    // applyBranchScope.
    // =======================================================================

    it('EC: staff cannot read a branch they are not assigned to', async () => {
      await seedInventory({ branchId: 'branch-A', productName: 'In Branch A' });
      await seedInventory({ branchId: 'branch-B', productName: 'In Branch B' });

      await expect(
        service.findAll(MERCHANT_UID, ['branch-A'], { branchId: 'branch-B' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('HP: staff CAN read a branch they are assigned to', async () => {
      await seedInventory({ branchId: 'branch-A', productName: 'In Branch A' });
      await seedInventory({ branchId: 'branch-B', productName: 'In Branch B' });

      const result = await service.findAll(MERCHANT_UID, ['branch-A'], {
        branchId: 'branch-A',
      });
      expect(result.total).toBe(1);
      expect(result.data[0].productName).toBe('In Branch A');
    });

    it('EC: staff with no branch filter sees only their assignment', async () => {
      await seedInventory({ branchId: 'branch-A', productName: 'In Branch A' });
      await seedInventory({ branchId: 'branch-B', productName: 'In Branch B' });

      const result = await service.findAll(MERCHANT_UID, ['branch-A'], {});
      expect(result.total).toBe(1);
      expect(result.data[0].productName).toBe('In Branch A');
    });

    it('EC: staff assigned no branches sees nothing, not everything', async () => {
      await seedInventory({ branchId: 'branch-A', productName: 'In Branch A' });
      await seedInventory({ branchId: 'branch-B', productName: 'In Branch B' });

      const result = await service.findAll(MERCHANT_UID, [], {});
      expect(result.total).toBe(0);
    });

    it('HP: search filters by productName (case-insensitive)', async () => {
      await seedInventory({ productName: 'Ariel Powder' });
      await seedInventory({ productName: 'Downy Fabric Conditioner' });

      const result = await service.findAll(MERCHANT_UID, null, {
        search: 'ariel',
      });
      expect(result.total).toBe(1);
      expect(result.data[0].productName).toBe('Ariel Powder');
    });

    it('HP: filters by inventoryCategory', async () => {
      await seedInventory({ inventoryCategory: 'powdered_detergent' });
      await seedInventory({ inventoryCategory: 'bleach' });

      const result = await service.findAll(MERCHANT_UID, null, {
        inventoryCategory: 'bleach' as any,
      });
      expect(result.total).toBe(1);
      expect(result.data[0].inventoryCategory).toBe('bleach');
    });

    it('HP: filters by isArchived', async () => {
      await seedInventory({ isArchived: false });
      await seedInventory({ isArchived: true });

      const active = await service.findAll(MERCHANT_UID, null, {
        isArchived: false,
      });
      expect(active.total).toBe(1);

      const archived = await service.findAll(MERCHANT_UID, null, {
        isArchived: true,
      });
      expect(archived.total).toBe(1);
    });
  });

  // =========================================================================
  // findById()
  // =========================================================================

  describe('findById()', () => {
    it('HP: returns the inventory item when found', async () => {
      const item = await seedInventory();
      const result = await service.findById(item._id.toString(), MERCHANT_UID);
      expect(result.productName).toBe('Ariel Powder');
    });

    it('EC: throws NotFoundException when id does not exist', async () => {
      const fakeId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
      await expect(service.findById(fakeId, MERCHANT_UID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('EC: throws NotFoundException when uid does not match', async () => {
      const item = await seedInventory({ uid: 'other-merchant' });
      await expect(
        service.findById(item._id.toString(), MERCHANT_UID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // update()
  // =========================================================================

  describe('update()', () => {
    it('HP: updates fields and returns updated document', async () => {
      const item = await seedInventory({ productName: 'Old Name', cost: 10 });
      const result = await service.update(item._id.toString(), MERCHANT_UID, {
        productName: 'New Name',
        cost: 50,
      });
      expect(result.productName).toBe('New Name');
      expect(result.cost).toBe(50);
    });

    it('EC: throws NotFoundException when item does not exist', async () => {
      const fakeId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
      await expect(
        service.update(fakeId, MERCHANT_UID, {} as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // restock()
  // =========================================================================

  describe('restock()', () => {
    it('HP: increments stockQuantity by the given quantity', async () => {
      const item = await seedInventory({ stockQuantity: 50 });
      const user = makeMerchantUser();
      const result = await service.restock(
        item._id.toString(),
        MERCHANT_UID,
        { quantity: 25 },
        user,
      );
      expect(result.stockQuantity).toBe(75);
    });

    it('HP: logs a RESTOCK transaction', async () => {
      const item = await seedInventory({ stockQuantity: 10 });
      const user = makeMerchantUser();
      await service.restock(
        item._id.toString(),
        MERCHANT_UID,
        { quantity: 5 },
        user,
      );

      const txs = await transactionModel
        .find({ type: TransactionType.RESTOCK })
        .exec();
      expect(txs).toHaveLength(1);
      expect(txs[0].quantityChange).toBe(5);
    });

    it('EC: throws NotFoundException when item does not exist', async () => {
      const fakeId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
      await expect(
        service.restock(
          fakeId,
          MERCHANT_UID,
          { quantity: 10 } as any,
          makeMerchantUser(),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('EC: throws BadRequestException when item is archived', async () => {
      const item = await seedInventory({ isArchived: true });
      await expect(
        service.restock(
          item._id.toString(),
          MERCHANT_UID,
          { quantity: 10 } as any,
          makeMerchantUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // adjust()
  // =========================================================================

  describe('adjust()', () => {
    it('HP: adjusts stockQuantity by a positive quantityChange', async () => {
      const item = await seedInventory({ stockQuantity: 20 });
      const result = await service.adjust(
        item._id.toString(),
        MERCHANT_UID,
        { quantityChange: 10, reason: 'recount' },
        makeMerchantUser(),
      );
      expect(result.stockQuantity).toBe(30);
    });

    it('HP: adjusts stockQuantity by a negative quantityChange', async () => {
      const item = await seedInventory({ stockQuantity: 20 });
      const result = await service.adjust(
        item._id.toString(),
        MERCHANT_UID,
        { quantityChange: -5, reason: 'recount' },
        makeMerchantUser(),
      );
      expect(result.stockQuantity).toBe(15);
    });

    it('HP: logs an ADJUSTMENT transaction', async () => {
      const item = await seedInventory({ stockQuantity: 20 });
      await service.adjust(
        item._id.toString(),
        MERCHANT_UID,
        { quantityChange: -3, reason: 'audit' },
        makeMerchantUser(),
      );

      const txs = await transactionModel
        .find({ type: TransactionType.ADJUSTMENT })
        .exec();
      expect(txs).toHaveLength(1);
      expect(txs[0].quantityChange).toBe(-3);
    });

    it('EC: throws BadRequestException when adjustment would result in negative stock', async () => {
      const item = await seedInventory({ stockQuantity: 5 });
      await expect(
        service.adjust(
          item._id.toString(),
          MERCHANT_UID,
          { quantityChange: -10, reason: 'recount' } as any,
          makeMerchantUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('EC: throws BadRequestException when item is archived', async () => {
      const item = await seedInventory({ isArchived: true });
      await expect(
        service.adjust(
          item._id.toString(),
          MERCHANT_UID,
          { quantityChange: 5, reason: 'recount' } as any,
          makeMerchantUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // damage()
  // =========================================================================

  describe('damage()', () => {
    it('HP: decrements stockQuantity by the given quantity', async () => {
      const item = await seedInventory({ stockQuantity: 30 });
      const result = await service.damage(
        item._id.toString(),
        MERCHANT_UID,
        { quantity: 10, reason: 'torn bag' },
        makeMerchantUser(),
      );
      expect(result.stockQuantity).toBe(20);
    });

    it('HP: logs a DAMAGE transaction with negative quantityChange', async () => {
      const item = await seedInventory({ stockQuantity: 30 });
      await service.damage(
        item._id.toString(),
        MERCHANT_UID,
        { quantity: 5, reason: 'torn bag' },
        makeMerchantUser(),
      );

      const txs = await transactionModel
        .find({ type: TransactionType.DAMAGE })
        .exec();
      expect(txs).toHaveLength(1);
      expect(txs[0].quantityChange).toBe(-5);
    });

    it('EC: throws BadRequestException when damage quantity exceeds stock', async () => {
      const item = await seedInventory({ stockQuantity: 3 });
      await expect(
        service.damage(
          item._id.toString(),
          MERCHANT_UID,
          { quantity: 10, reason: 'oops' } as any,
          makeMerchantUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('EC: throws BadRequestException when item is archived', async () => {
      const item = await seedInventory({ isArchived: true, stockQuantity: 50 });
      await expect(
        service.damage(
          item._id.toString(),
          MERCHANT_UID,
          { quantity: 5, reason: 'oops' } as any,
          makeMerchantUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // archive()
  // =========================================================================

  describe('archive()', () => {
    it('HP: sets isArchived to true and records archivedAt', async () => {
      const item = await seedInventory({ isArchived: false });
      const result = await service.archive(item._id.toString(), MERCHANT_UID);
      expect(result.isArchived).toBe(true);
      expect(result.archivedAt).toBeDefined();
    });

    it('EC: throws NotFoundException when item does not exist', async () => {
      await expect(
        service.archive('aaaaaaaaaaaaaaaaaaaaaaaa', MERCHANT_UID),
      ).rejects.toThrow(NotFoundException);
    });

    it('EC: throws BadRequestException when item is already archived', async () => {
      const item = await seedInventory({ isArchived: true });
      await expect(
        service.archive(item._id.toString(), MERCHANT_UID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // restore()
  // =========================================================================

  describe('restore()', () => {
    it('HP: sets isArchived to false and clears archivedAt', async () => {
      const item = await seedInventory({
        isArchived: true,
        archivedAt: new Date(),
      });
      const result = await service.restore(item._id.toString(), MERCHANT_UID);
      expect(result.isArchived).toBe(false);
      expect(result.archivedAt).toBeNull();
    });

    it('EC: throws NotFoundException when item does not exist', async () => {
      await expect(
        service.restore('aaaaaaaaaaaaaaaaaaaaaaaa', MERCHANT_UID),
      ).rejects.toThrow(NotFoundException);
    });

    it('EC: throws BadRequestException when item is not archived', async () => {
      const item = await seedInventory({ isArchived: false });
      await expect(
        service.restore(item._id.toString(), MERCHANT_UID),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
