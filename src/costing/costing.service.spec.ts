// Mock the Branch schema FIRST — before any import that pulls in @nestjs/graphql
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

import { Test, TestingModule } from '@nestjs/testing';
import {
  MongooseModule,
  getConnectionToken,
  getModelToken,
} from '@nestjs/mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { CostingService } from './costing.service';
import {
  CostingConfig,
  CostingConfigSchema,
} from './schemas/costing-config.schema';
import {
  CostingReport,
  CostingReportSchema,
} from './schemas/costing-report.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';

// ─── constants ───────────────────────────────────────────────────────────────

const MERCHANT = 'merchant-uid-001';
const WRONG_UID = 'wrong-uid-999';
// Valid 24-char hex ObjectId — used as a branchId for "branch not found" cases
const NONEXISTENT_BRANCH_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

// ─── suite ───────────────────────────────────────────────────────────────────

describe('CostingService (integration)', () => {
  let mongod: MongoMemoryServer;
  let module: TestingModule;
  let service: CostingService;
  let mongoConnection: Connection;
  let branchModel: Model<any>;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: CostingConfig.name, schema: CostingConfigSchema },
          { name: CostingReport.name, schema: CostingReportSchema },
          { name: Branch.name, schema: BranchSchema },
        ]),
      ],
      providers: [CostingService],
    }).compile();

    service = module.get<CostingService>(CostingService);
    mongoConnection = module.get<Connection>(getConnectionToken());
    branchModel = module.get<Model<any>>(getModelToken(Branch.name));
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

  // ── helpers ────────────────────────────────────────────────────────────────

  async function seedBranch(overrides: Record<string, any> = {}) {
    return branchModel.create({
      uid: MERCHANT,
      branchName: 'Main Branch',
      isActive: true,
      ...overrides,
    });
  }

  // ── getCostingConfig ───────────────────────────────────────────────────────

  describe('getCostingConfig()', () => {
    it('[EC] throws ForbiddenException when branch does not exist', async () => {
      await expect(
        service.getCostingConfig(NONEXISTENT_BRANCH_ID, MERCHANT),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[EC] throws ForbiddenException when uid does not match the branch owner', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await expect(
        service.getCostingConfig(branchId, WRONG_UID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[HP] returns empty object when no config has been saved yet', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      const result = await service.getCostingConfig(branchId, MERCHANT);
      expect(result).toEqual({});
    });

    it('[HP] returns the previously saved config object', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();
      const config = { laborCostPct: 0.15, overheadPct: 0.1 };

      await service.upsertCostingConfig(branchId, MERCHANT, config);
      const result = await service.getCostingConfig(branchId, MERCHANT);

      expect(result).toMatchObject(config);
    });
  });

  // ── upsertCostingConfig ────────────────────────────────────────────────────

  describe('upsertCostingConfig()', () => {
    it('[EC] throws ForbiddenException when branch does not exist', async () => {
      await expect(
        service.upsertCostingConfig(NONEXISTENT_BRANCH_ID, MERCHANT, { x: 1 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[HP] insert path — creates a new config and returns it', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();
      const config = { recipeCostPct: 0.3 };

      const result = await service.upsertCostingConfig(
        branchId,
        MERCHANT,
        config,
      );
      expect(result).toMatchObject(config);
    });

    it('[HP] update path — overwrites existing config with new values', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await service.upsertCostingConfig(branchId, MERCHANT, { phase: 1 });
      const result = await service.upsertCostingConfig(branchId, MERCHANT, {
        phase: 2,
      });

      expect(result).toMatchObject({ phase: 2 });
    });

    it('[HP] IDEMPOTENCY — calling twice returns the LATEST config, no duplicate document', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await service.upsertCostingConfig(branchId, MERCHANT, { value: 'first' });
      const second = await service.upsertCostingConfig(branchId, MERCHANT, {
        value: 'second',
      });

      expect(second).toMatchObject({ value: 'second' });

      // Only one document should exist for this uid+branchId pair
      const count = await mongoConnection.collections[
        'costing_configs'
      ].countDocuments({
        uid: MERCHANT,
        branchId,
      });
      expect(count).toBe(1);
    });
  });

  // ── getCostingReports ──────────────────────────────────────────────────────

  describe('getCostingReports()', () => {
    it('[EC] throws ForbiddenException when uid does not match branch owner', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await expect(
        service.getCostingReports(branchId, WRONG_UID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[HP] returns empty array when no reports have been saved', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      const result = await service.getCostingReports(branchId, MERCHANT);
      expect(result).toEqual([]);
    });

    it('[HP] returns reports sorted by date descending', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-01-01' },
        'user-a',
      );
      await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-03-15' },
        'user-a',
      );
      await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-02-10' },
        'user-a',
      );

      const result = await service.getCostingReports(branchId, MERCHANT);
      const dates = result.map((r) => r.date);
      expect(dates).toEqual(['2025-03-15', '2025-02-10', '2025-01-01']);
    });

    it('[HP] limit parameter restricts the number of returned documents', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      // Seed 5 reports
      for (let i = 1; i <= 5; i++) {
        const date = `2025-0${i}-01`;
        await service.upsertCostingReport(
          branchId,
          MERCHANT,
          { date },
          'user-a',
        );
      }

      const result = await service.getCostingReports(branchId, MERCHANT, 2);
      expect(result).toHaveLength(2);
    });

    it('[HP] each returned entry has id and date fields', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-06-01', kilos: 100 },
        'user-a',
      );

      const [entry] = await service.getCostingReports(branchId, MERCHANT);
      expect(entry.id).toBeDefined();
      expect(entry.date).toBe('2025-06-01');
    });
  });

  // ── upsertCostingReport ────────────────────────────────────────────────────

  describe('upsertCostingReport()', () => {
    it('[EC] throws BadRequestException when report.date is missing', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await expect(
        service.upsertCostingReport(
          branchId,
          MERCHANT,
          { kilos: 50 },
          'user-a',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('[EC] BadRequestException message describes the date format requirement', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await expect(
        service.upsertCostingReport(
          branchId,
          MERCHANT,
          { kilos: 50 },
          'user-a',
        ),
      ).rejects.toThrow('Please provide a valid report date.');
    });

    it('[EC] throws BadRequestException when date is in wrong format (not YYYY-MM-DD)', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await expect(
        service.upsertCostingReport(
          branchId,
          MERCHANT,
          { date: '06/27/2025' },
          'user-a',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('[EC] throws ForbiddenException when branch does not exist', async () => {
      await expect(
        service.upsertCostingReport(
          NONEXISTENT_BRANCH_ID,
          MERCHANT,
          { date: '2025-06-27' },
          'user-a',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[HP] insert path — creates a new report and sets createdBy', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      const stub = await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-06-01', kilos: 80 },
        'user-creator',
      );

      expect(stub.id).toBeDefined();
      expect(stub.date).toBe('2025-06-01');

      // Verify createdBy was persisted
      const doc = await mongoConnection.collections['costing_reports'].findOne({
        uid: MERCHANT,
        branchId,
        date: '2025-06-01',
      });
      expect(doc?.createdBy).toBe('user-creator');
    });

    it('[HP] IDEMPOTENCY — saving the same date twice updates updatedBy and does NOT create a duplicate', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-07-01', kilos: 50 },
        'user-first',
      );
      await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-07-01', kilos: 60 },
        'user-second',
      );

      // Exactly one document should exist for this date
      const count = await mongoConnection.collections[
        'costing_reports'
      ].countDocuments({
        uid: MERCHANT,
        branchId,
        date: '2025-07-01',
      });
      expect(count).toBe(1);

      // updatedBy reflects the second caller
      const doc = await mongoConnection.collections['costing_reports'].findOne({
        uid: MERCHANT,
        branchId,
        date: '2025-07-01',
      });
      expect(doc?.updatedBy).toBe('user-second');
    });

    it('[HP] returned stub contains correct id and date after upsert', async () => {
      const branch = await seedBranch();
      const branchId = branch._id.toString();

      const stub = await service.upsertCostingReport(
        branchId,
        MERCHANT,
        { date: '2025-08-15' },
        'user-a',
      );

      expect(typeof stub.id).toBe('string');
      expect(stub.id).toHaveLength(24); // Mongoose ObjectId hex string
      expect(stub.date).toBe('2025-08-15');
    });
  });
});
