jest.mock('../pos_orders/schemas/pos-order.schema', () => {
  const mongoose = require('mongoose');
  return {
    PosOrder: class PosOrder {},
    PosOrderSchema: new mongoose.Schema(
      {
        uid: { type: String, required: true },
        branchId: { type: String, required: true },
        createdBy: { type: String, required: true },
        createdByType: { type: String, required: true },
        customerName: { type: String, default: null },
        customerPhone: { type: String, default: null },
        paymentStatus: {
          type: String,
          enum: ['unpaid', 'paid', 'refunded'],
          default: 'unpaid',
        },
        laundryStatus: {
          type: String,
          enum: [
            'pending',
            'in_progress',
            'ready',
            'completed',
            'cancelled',
            'void',
          ],
          default: 'pending',
        },
        subtotal: { type: Number, required: true, default: 0 },
        discountType: {
          type: String,
          enum: ['flat', 'percentage'],
          default: null,
        },
        discountValue: { type: Number, default: null },
        discount: { type: Number, default: 0 },
        totalAmount: { type: Number, required: true, default: 0 },
        claimCode: { type: String, required: true, unique: true },
        notes: { type: String, default: null },
        idempotencyKey: { type: String, default: null },
        claimedBy: { type: String, default: null },
        items: { type: Array, default: [] },
        estimatedReadyAt: { type: Date, default: null },
        claimedAt: { type: Date, default: null },
      },
      { collection: 'pos_orders', timestamps: true },
    ),
    PaymentStatus: {
      UNPAID: 'unpaid',
      PAID: 'paid',
      REFUNDED: 'refunded',
    },
    LaundryStatus: {
      PENDING: 'pending',
      IN_PROGRESS: 'in_progress',
      READY: 'ready',
      COMPLETED: 'completed',
      CANCELLED: 'cancelled',
      VOID: 'void',
    },
    DiscountType: { flat: 'flat', percentage: 'percentage' },
    OrderItemType: { service: 'service', product: 'product' },
  };
});

jest.mock('../branches/schemas/branch.schema', () => {
  const mongoose = require('mongoose');
  return {
    Branch: class Branch {},
    BranchSchema: new mongoose.Schema(
      {
        // Use String _id so $lookup on branchId (string) matches branch._id (string)
        _id: {
          type: String,
          default: () => new mongoose.Types.ObjectId().toHexString(),
        },
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
import { Connection, Model } from 'mongoose';
import {
  PosOrder,
  PosOrderSchema,
  PaymentStatus,
} from '../pos_orders/schemas/pos-order.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { AnalyticsService } from './analytics.service';
import { AnalyticsGranularity } from './dto/analytics-filter.input';
import { BadRequestException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFilter = (overrides: Record<string, any> = {}) => ({
  dateFrom: new Date('2026-01-01T00:00:00.000Z'),
  dateTo: new Date('2026-12-31T23:59:59.999Z'),
  ...overrides,
});

let claimCodeCounter = 0;
const nextClaimCode = () => `CC-${Date.now()}-${++claimCodeCounter}`;

const makeOrder = (overrides: Record<string, any> = {}) => ({
  uid: 'merchant-1',
  branchId: 'branch-aaa',
  createdBy: 'staff-1',
  createdByType: 'staff',
  paymentStatus: PaymentStatus.PAID,
  laundryStatus: 'pending',
  subtotal: 100,
  totalAmount: 100,
  discount: 0,
  claimCode: nextClaimCode(),
  items: [],
  createdAt: new Date('2026-03-15T10:00:00.000Z'),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AnalyticsService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: AnalyticsService;
  let module: TestingModule;
  let orderModel: Model<any>;
  let branchModel: Model<any>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          {
            name: (PosOrder as any).name || 'PosOrder',
            schema: PosOrderSchema,
          },
          { name: (Branch as any).name || 'Branch', schema: BranchSchema },
        ]),
      ],
      providers: [AnalyticsService],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    mongoConnection = module.get<Connection>(getConnectionToken());
    orderModel = module.get(
      getModelToken((PosOrder as any).name || 'PosOrder'),
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
  // Error / edge cases
  // -------------------------------------------------------------------------

  describe('getRevenueSummary — error cases', () => {
    it('EC: throws BadRequestException when dateFrom > dateTo', async () => {
      const filter = makeFilter({
        dateFrom: new Date('2026-12-31'),
        dateTo: new Date('2026-01-01'),
      });
      await expect(
        service.getRevenueSummary('merchant-1', null, filter),
      ).rejects.toThrow(BadRequestException);
    });

    it('EC: throws BadRequestException when branchId is not a 24-char hex string', async () => {
      const filter = makeFilter({ branchId: 'not-valid' });
      await expect(
        service.getRevenueSummary('merchant-1', null, filter),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // getRevenueSummary — happy paths
  // -------------------------------------------------------------------------

  describe('getRevenueSummary — happy paths', () => {
    it('HP: returns all zeros when there are no orders', async () => {
      const result = await service.getRevenueSummary(
        'merchant-1',
        null,
        makeFilter(),
      );
      expect(result).toEqual({
        totalRevenue: 0,
        totalOrders: 0,
        avgOrderValue: 0,
        totalDiscounts: 0,
        totalRefunded: 0,
      });
    });

    it('HP: sums totalAmount for PAID orders correctly', async () => {
      await orderModel.create([
        makeOrder({ totalAmount: 200, discount: 10 }),
        makeOrder({ totalAmount: 300, discount: 20 }),
      ]);

      const result = await service.getRevenueSummary(
        'merchant-1',
        null,
        makeFilter(),
      );
      expect(result.totalRevenue).toBe(500);
      expect(result.totalOrders).toBe(2);
      expect(result.totalDiscounts).toBe(30);
      expect(result.avgOrderValue).toBeCloseTo(250);
    });

    it('HP: excludes UNPAID orders from totalRevenue', async () => {
      await orderModel.create([
        makeOrder({ totalAmount: 150, paymentStatus: PaymentStatus.PAID }),
        makeOrder({ totalAmount: 999, paymentStatus: PaymentStatus.UNPAID }),
      ]);

      const result = await service.getRevenueSummary(
        'merchant-1',
        null,
        makeFilter(),
      );
      expect(result.totalRevenue).toBe(150);
      expect(result.totalOrders).toBe(1);
    });

    it('HP: counts REFUNDED orders in totalRefunded, not totalRevenue', async () => {
      await orderModel.create([
        makeOrder({ totalAmount: 100, paymentStatus: PaymentStatus.PAID }),
        makeOrder({ totalAmount: 50, paymentStatus: PaymentStatus.REFUNDED }),
      ]);

      const result = await service.getRevenueSummary(
        'merchant-1',
        null,
        makeFilter(),
      );
      expect(result.totalRevenue).toBe(100);
      expect(result.totalRefunded).toBe(50);
    });

    it('HP: branchId filter — only returns revenue for that specific branch', async () => {
      const branchA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
      const branchB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
      await orderModel.create([
        makeOrder({ totalAmount: 400, branchId: branchA }),
        makeOrder({ totalAmount: 600, branchId: branchB }),
      ]);

      const result = await service.getRevenueSummary(
        'merchant-1',
        null,
        makeFilter({ branchId: branchA }),
      );
      expect(result.totalRevenue).toBe(400);
      expect(result.totalOrders).toBe(1);
    });

    it('HP: does not include orders from a different merchant uid', async () => {
      await orderModel.create([
        makeOrder({ uid: 'merchant-1', totalAmount: 100 }),
        makeOrder({ uid: 'merchant-2', totalAmount: 9000 }),
      ]);

      const result = await service.getRevenueSummary(
        'merchant-1',
        null,
        makeFilter(),
      );
      expect(result.totalRevenue).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // getRevenueSummaryByBranch
  // -------------------------------------------------------------------------

  describe('getRevenueSummaryByBranch', () => {
    it('HP: returns empty array when there are no orders', async () => {
      const result = await service.getRevenueSummaryByBranch(
        'merchant-1',
        makeFilter(),
      );
      expect(result).toEqual([]);
    });

    it('HP: groups by branch and returns branchName from $lookup', async () => {
      // Insert a branch document with a known _id so the $lookup resolves
      const branch = await branchModel.create({
        uid: 'merchant-1',
        branchName: 'Main Branch',
        isActive: true,
        isOnline: true,
      });
      const branchId = branch._id.toString();

      await orderModel.create([
        makeOrder({ branchId, totalAmount: 300 }),
        makeOrder({ branchId, totalAmount: 200 }),
      ]);

      const result = await service.getRevenueSummaryByBranch(
        'merchant-1',
        makeFilter(),
      );
      expect(result).toHaveLength(1);
      expect(result[0].branchName).toBe('Main Branch');
      expect(result[0].totalRevenue).toBe(500);
      expect(result[0].totalOrders).toBe(2);
    });

    it('HP: branches with no matching branch doc get "Unknown Branch" name', async () => {
      await orderModel.create(
        makeOrder({ branchId: 'unknownbranch000000000001', totalAmount: 75 }),
      );

      const result = await service.getRevenueSummaryByBranch(
        'merchant-1',
        makeFilter(),
      );
      expect(result).toHaveLength(1);
      expect(result[0].branchName).toBe('Unknown Branch');
    });

    it('HP: sorted by totalRevenue descending', async () => {
      const b1 = await branchModel.create({
        uid: 'merchant-1',
        branchName: 'Alpha',
        isActive: true,
        isOnline: true,
      });
      const b2 = await branchModel.create({
        uid: 'merchant-1',
        branchName: 'Beta',
        isActive: true,
        isOnline: true,
      });

      await orderModel.create([
        makeOrder({ branchId: b1._id.toString(), totalAmount: 100 }),
        makeOrder({ branchId: b2._id.toString(), totalAmount: 500 }),
      ]);

      const result = await service.getRevenueSummaryByBranch(
        'merchant-1',
        makeFilter(),
      );
      expect(result[0].totalRevenue).toBeGreaterThanOrEqual(
        result[1].totalRevenue,
      );
    });

    it('EC: throws BadRequestException when dateFrom > dateTo', async () => {
      const filter = makeFilter({
        dateFrom: new Date('2026-12-31'),
        dateTo: new Date('2026-01-01'),
      });
      await expect(
        service.getRevenueSummaryByBranch('merchant-1', filter),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // getRevenueOverTime
  // -------------------------------------------------------------------------

  describe('getRevenueOverTime', () => {
    it('HP: groups by DAY — returns one entry per day with correct totals', async () => {
      await orderModel.create([
        makeOrder({
          totalAmount: 100,
          createdAt: new Date('2026-03-01T02:00:00.000Z'),
        }),
        makeOrder({
          totalAmount: 200,
          createdAt: new Date('2026-03-01T03:00:00.000Z'),
        }),
        makeOrder({
          totalAmount: 50,
          createdAt: new Date('2026-03-02T02:00:00.000Z'),
        }),
      ]);

      const result = await service.getRevenueOverTime(
        'merchant-1',
        null,
        makeFilter({ granularity: AnalyticsGranularity.DAY }),
      );

      expect(result.length).toBeGreaterThanOrEqual(2);
      // Find the day entries (period strings like '2026-03-01')
      const march1 = result.find((r) => r.period?.includes('2026-03-01'));
      const march2 = result.find((r) => r.period?.includes('2026-03-02'));
      expect(march1).toBeDefined();
      expect(march1!.totalRevenue).toBe(300);
      expect(march1!.orderCount).toBe(2);
      expect(march2).toBeDefined();
      expect(march2!.totalRevenue).toBe(50);
    });

    it('HP: groups by MONTH — orders in same month appear as one entry', async () => {
      await orderModel.create([
        makeOrder({
          totalAmount: 100,
          createdAt: new Date('2026-03-05T02:00:00.000Z'),
        }),
        makeOrder({
          totalAmount: 200,
          createdAt: new Date('2026-03-20T02:00:00.000Z'),
        }),
        makeOrder({
          totalAmount: 50,
          createdAt: new Date('2026-04-01T02:00:00.000Z'),
        }),
      ]);

      const result = await service.getRevenueOverTime(
        'merchant-1',
        null,
        makeFilter({ granularity: AnalyticsGranularity.MONTH }),
      );

      const march = result.find((r) => r.period?.includes('2026-03'));
      const april = result.find((r) => r.period?.includes('2026-04'));
      expect(march).toBeDefined();
      expect(march!.totalRevenue).toBe(300);
      expect(april).toBeDefined();
      expect(april!.totalRevenue).toBe(50);
    });

    it('HP: UNPAID orders are excluded from the time series', async () => {
      await orderModel.create([
        makeOrder({
          totalAmount: 100,
          paymentStatus: PaymentStatus.PAID,
          createdAt: new Date('2026-03-01T02:00:00.000Z'),
        }),
        makeOrder({
          totalAmount: 9999,
          paymentStatus: PaymentStatus.UNPAID,
          createdAt: new Date('2026-03-01T03:00:00.000Z'),
        }),
      ]);

      const result = await service.getRevenueOverTime(
        'merchant-1',
        null,
        makeFilter({ granularity: AnalyticsGranularity.DAY }),
      );

      const total = result.reduce((sum, r) => sum + r.totalRevenue, 0);
      expect(total).toBe(100);
    });

    it('HP: returns empty array when there are no PAID orders', async () => {
      await orderModel.create(
        makeOrder({ paymentStatus: PaymentStatus.UNPAID, totalAmount: 500 }),
      );

      const result = await service.getRevenueOverTime(
        'merchant-1',
        null,
        makeFilter(),
      );
      expect(result).toEqual([]);
    });

    it('EC: throws BadRequestException when dateFrom > dateTo', async () => {
      const filter = makeFilter({
        dateFrom: new Date('2026-12-31'),
        dateTo: new Date('2026-01-01'),
      });
      await expect(
        service.getRevenueOverTime('merchant-1', null, filter),
      ).rejects.toThrow(BadRequestException);
    });

    it('EC: throws BadRequestException when branchId is invalid hex', async () => {
      const filter = makeFilter({ branchId: 'bad-id' });
      await expect(
        service.getRevenueOverTime('merchant-1', null, filter),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
