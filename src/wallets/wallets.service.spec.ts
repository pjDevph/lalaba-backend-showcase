import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { WalletsService } from './wallets.service';
import { WalletAcceptanceGuardService } from './wallet-acceptance-guard.service';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntrySchema,
} from './schemas/wallet-ledger-entry.schema';
import {
  TopUpIntent,
  TopUpIntentSchema,
  TopUpIntentStatus,
} from './schemas/topup-intent.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  CreateInvoiceRequest,
  CreateInvoiceResult,
  PaymentGatewayService,
} from './gateway/payment-gateway.service';
import { TopUpWalletInput } from './dto/top-up-wallet.input';
import {
  ACTIVATION_MIN_CENTAVOS,
  TOP_UP_HISTORY_LIMIT,
} from './wallet.constants';

// ---------------------------------------------------------------------------
// Controllable gateway mock — flip autoSucceeds per test.
// ---------------------------------------------------------------------------

class MockGateway extends PaymentGatewayService {
  readonly name = 'mock';
  autoSucceeds = false;
  failNext = false;
  calls: CreateInvoiceRequest[] = [];

  createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
    this.calls.push(req);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('gateway down'));
    }
    return Promise.resolve({
      gatewayInvoiceId: `inv_${req.intentId}`,
      invoiceUrl: `https://checkout.example/${req.intentId}`,
      autoSucceeds: this.autoSucceeds,
    });
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('WalletsService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let mongoConnection: Connection;
  let module: TestingModule;
  let service: WalletsService;
  let guard: WalletAcceptanceGuardService;
  let gateway: MockGateway;

  const OWNER = 'owner-uid-001';

  const makeBranch = async (overrides: Record<string, any> = {}) => {
    const branchModel = mongoConnection.models[Branch.name];
    const branch = await branchModel.create({
      uid: OWNER,
      branchName: `Branch ${new Types.ObjectId().toString()}`,
      branchPhoneNumber: '09171234567',
      branchAddress: {
        regionName: 'NCR',
        provinceName: 'Metro Manila',
        cityMunicipalityName: 'Makati',
        barangayName: 'Bel-Air',
        streetAddress: '123 Test St',
      },
      branchMapLocation: { latitude: 14.55, longitude: 121.02 },
      operatingHours: {},
      // Deliberately NOT approved — KYC state must not gate funding.
      verificationStatus: 'PENDING',
      ...overrides,
    });
    return String(branch._id);
  };

  const paidEvent = (intentId: string, amountCentavos: number) => ({
    reference: intentId,
    amountCentavos,
    currency: 'PHP',
    gatewayInvoiceId: `inv_${intentId}`,
  });

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    gateway = new MockGateway();
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletLedgerEntry.name, schema: WalletLedgerEntrySchema },
          { name: TopUpIntent.name, schema: TopUpIntentSchema },
          { name: Branch.name, schema: BranchSchema },
        ]),
      ],
      providers: [
        WalletsService,
        WalletAcceptanceGuardService,
        { provide: PaymentGatewayService, useValue: gateway },
      ],
    }).compile();

    service = module.get(WalletsService);
    guard = module.get(WalletAcceptanceGuardService);
    mongoConnection = module.get<Connection>(getConnectionToken());

    // The unique (branchId, xenditReference) partial index is the
    // double-credit backstop under test — make sure it exists, and that the
    // collections exist before they're first touched inside a transaction.
    await mongoConnection.models[WalletLedgerEntry.name].createCollection();
    await mongoConnection.models[Wallet.name].createCollection();
    await mongoConnection.models[TopUpIntent.name].createCollection();
    await mongoConnection.models[WalletLedgerEntry.name].syncIndexes();
    await mongoConnection.models[Wallet.name].syncIndexes();
  }, 120_000);

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await module.close();
    await replSet.stop();
  });

  afterEach(async () => {
    gateway.autoSucceeds = false;
    gateway.failNext = false;
    gateway.calls = [];
    for (const key of Object.keys(mongoConnection.collections)) {
      await mongoConnection.collections[key].deleteMany({});
    }
  });

  // -------------------------------------------------------------------------
  // initializeTopUp — secure lifecycle
  // -------------------------------------------------------------------------

  describe('initializeTopUp', () => {
    it('[CANONICAL RULE] allows a KYC-pending owner to initialize a top-up', async () => {
      const branchId = await makeBranch({ verificationStatus: 'PENDING' });
      await service.createWallet(branchId);

      const intent = await service.initializeTopUp(branchId, 50_000, OWNER);
      expect(intent.status).toBe(TopUpIntentStatus.PENDING);
      expect(intent.invoiceUrl).toContain('https://checkout.example/');
    });

    it('[HP] creates a PENDING intent and does NOT credit the wallet', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);

      const intent = await service.initializeTopUp(branchId, 100_000, OWNER);

      expect(intent.status).toBe(TopUpIntentStatus.PENDING);
      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(0);
      expect(wallet.activatedAt).toBeNull();
      const rows = await service.ledger(branchId);
      expect(rows).toHaveLength(0);
    });

    it('[HP] dev auto-succeed gateway settles through postVerifiedTopUp (credit + activation)', async () => {
      gateway.autoSucceeds = true;
      const branchId = await makeBranch();
      await service.createWallet(branchId);

      const intent = await service.initializeTopUp(
        branchId,
        ACTIVATION_MIN_CENTAVOS,
        OWNER,
      );

      expect(intent.status).toBe(TopUpIntentStatus.SUCCEEDED);
      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(ACTIVATION_MIN_CENTAVOS);
      expect(wallet.activatedAt).toBeTruthy();
      const rows = await service.ledger(branchId);
      expect(rows).toHaveLength(1);
      expect(rows[0].xenditReference).toBe(String(intent._id));
    });

    it('[NEG] rejects a non-owner', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      await expect(
        service.initializeTopUp(branchId, 10_000, 'someone-else'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[NEG] rejects a deactivated branch', async () => {
      const branchId = await makeBranch({ isActive: false });
      await service.createWallet(branchId);
      await expect(
        service.initializeTopUp(branchId, 10_000, OWNER),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[NEG] rejects fractional, zero, and negative centavo amounts', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      for (const bad of [100.5, 0, -500, NaN]) {
        await expect(
          service.initializeTopUp(branchId, bad, OWNER),
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('[NEG] marks the intent FAILED when the gateway call fails', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      gateway.failNext = true;
      await expect(
        service.initializeTopUp(branchId, 10_000, OWNER),
      ).rejects.toThrow('gateway down');
      const intents = await mongoConnection.models[TopUpIntent.name]
        .find({ branchId })
        .exec();
      expect(intents).toHaveLength(1);
      expect(intents[0].status).toBe(TopUpIntentStatus.FAILED);
    });

    it('[GAP-M-021] lazily heals a missing wallet before taking money', async () => {
      const branchId = await makeBranch();
      // no createWallet — simulates the branch-created-but-wallet-lost state
      await service.initializeTopUp(branchId, 10_000, OWNER);
      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // postVerifiedTopUp — idempotency and verification
  // -------------------------------------------------------------------------

  describe('postVerifiedTopUp', () => {
    it('[HP] credits once and stamps activation at the ₱1,000 threshold', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(
        branchId,
        ACTIVATION_MIN_CENTAVOS,
        OWNER,
      );
      const intentId = String(intent._id);

      const result = await service.postVerifiedTopUp(
        intentId,
        paidEvent(intentId, ACTIVATION_MIN_CENTAVOS),
      );
      expect(result.alreadyPosted).toBe(false);
      expect(result.intent.status).toBe(TopUpIntentStatus.SUCCEEDED);
      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(ACTIVATION_MIN_CENTAVOS);
      expect(wallet.activatedAt).toBeTruthy();
    });

    it('[HP] below the activation threshold, no activatedAt stamp', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 50_000, OWNER);
      const intentId = String(intent._id);
      await service.postVerifiedTopUp(intentId, paidEvent(intentId, 50_000));
      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(50_000);
      expect(wallet.activatedAt).toBeNull();
    });

    it('[IDEMPOTENCY] a replayed webhook cannot double-credit', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 25_000, OWNER);
      const intentId = String(intent._id);

      const first = await service.postVerifiedTopUp(
        intentId,
        paidEvent(intentId, 25_000),
      );
      const second = await service.postVerifiedTopUp(
        intentId,
        paidEvent(intentId, 25_000),
      );

      expect(first.alreadyPosted).toBe(false);
      expect(second.alreadyPosted).toBe(true);
      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(25_000);
      const rows = await service.ledger(branchId);
      expect(rows).toHaveLength(1);
    });

    it('[IDEMPOTENCY/DB] the unique ledger index blocks a double-post even if the intent claim is forged back to PENDING', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 25_000, OWNER);
      const intentId = String(intent._id);
      await service.postVerifiedTopUp(intentId, paidEvent(intentId, 25_000));

      // Simulate a forged/corrupted state that defeats the status-claim layer:
      // the ledger's unique (branchId, xenditReference) index must still hold.
      await mongoConnection.models[TopUpIntent.name]
        .updateOne(
          { _id: intentId },
          { $set: { status: TopUpIntentStatus.PENDING } },
        )
        .exec();

      const replay = await service.postVerifiedTopUp(
        intentId,
        paidEvent(intentId, 25_000),
      );
      expect(replay.alreadyPosted).toBe(true);

      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(25_000); // credited exactly once
      const rows = await service.ledger(branchId);
      expect(rows).toHaveLength(1);
    });

    it('[NEG] rejects an amount mismatch without crediting', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 25_000, OWNER);
      const intentId = String(intent._id);

      await expect(
        service.postVerifiedTopUp(intentId, paidEvent(intentId, 24_999)),
      ).rejects.toThrow(BadRequestException);
      const wallet = await service.getWallet(branchId);
      expect(wallet.balanceCentavos).toBe(0);
      expect(await service.ledger(branchId)).toHaveLength(0);
    });

    it('[NEG] rejects a non-PHP currency', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 25_000, OWNER);
      const intentId = String(intent._id);
      await expect(
        service.postVerifiedTopUp(intentId, {
          ...paidEvent(intentId, 25_000),
          currency: 'USD',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('[NEG] rejects a forged/unknown reference', async () => {
      await expect(
        service.postVerifiedTopUp(
          new Types.ObjectId().toString(),
          paidEvent(new Types.ObjectId().toString(), 25_000),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('[NEG] refuses to credit an EXPIRED intent', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 25_000, OWNER);
      const intentId = String(intent._id);
      await service.resolveIntentWithoutCredit(
        intentId,
        TopUpIntentStatus.EXPIRED,
      );
      await expect(
        service.postVerifiedTopUp(intentId, paidEvent(intentId, 25_000)),
      ).rejects.toThrow(BadRequestException);
      expect((await service.getWallet(branchId)).balanceCentavos).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // topUpStatus polling
  // -------------------------------------------------------------------------

  describe('topUpStatus', () => {
    it('[HP] returns the intent for its owner and rejects others', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 10_000, OWNER);
      const intentId = String(intent._id);

      const fetched = await service.topUpStatus(intentId, OWNER);
      expect(fetched.status).toBe(TopUpIntentStatus.PENDING);
      await expect(
        service.topUpStatus(intentId, 'someone-else'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // topUpHistory — the attempts the ledger cannot show
  // -------------------------------------------------------------------------

  describe('topUpHistory', () => {
    it('[HP] lists attempts the ledger never records (PENDING / FAILED)', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);

      // One settled credit...
      gateway.autoSucceeds = true;
      const settled = await service.initializeTopUp(branchId, 20_000, OWNER);
      // ...one still on the checkout page, one the gateway rejected.
      gateway.autoSucceeds = false;
      const pending = await service.initializeTopUp(branchId, 30_000, OWNER);
      const failed = await service.initializeTopUp(branchId, 40_000, OWNER);
      await mongoConnection.models[TopUpIntent.name].updateOne(
        { _id: failed._id },
        { $set: { status: TopUpIntentStatus.FAILED } },
      );

      // The ledger sees only the money that actually moved — which is exactly
      // why this query has to exist.
      expect(await service.ledger(branchId)).toHaveLength(1);

      const history = await service.topUpHistory(branchId);
      expect(history).toHaveLength(3);
      const byId = new Map(history.map((i) => [String(i._id), i.status]));
      expect(byId.get(String(settled._id))).toBe(TopUpIntentStatus.SUCCEEDED);
      expect(byId.get(String(pending._id))).toBe(TopUpIntentStatus.PENDING);
      expect(byId.get(String(failed._id))).toBe(TopUpIntentStatus.FAILED);
    });

    it('[HP] returns newest first', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);

      const first = await service.initializeTopUp(branchId, 10_000, OWNER);
      const second = await service.initializeTopUp(branchId, 20_000, OWNER);
      const third = await service.initializeTopUp(branchId, 30_000, OWNER);

      // createdAt is second-granular in Mongo and these three land in the same
      // tick, so assert on the set + the sort key rather than exact positions.
      const history = await service.topUpHistory(branchId);
      expect(history.map((i) => String(i._id)).sort()).toEqual(
        [first, second, third].map((i) => String(i._id)).sort(),
      );
      const times = history.map((i) => i.createdAt?.getTime() ?? 0);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('[NEG] never leaks another branch’s attempts', async () => {
      const mine = await makeBranch();
      const theirs = await makeBranch();
      await service.createWallet(mine);
      await service.createWallet(theirs);
      await service.initializeTopUp(mine, 10_000, OWNER);
      await service.initializeTopUp(theirs, 90_000, OWNER);

      const history = await service.topUpHistory(mine);
      expect(history).toHaveLength(1);
      expect(history[0].amountCentavos).toBe(10_000);
    });

    it('[HP] is empty for a branch that has never attempted a top-up', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      expect(await service.topUpHistory(branchId)).toEqual([]);
    });

    it('[NEG] caps the page so an abandoned-checkout pile cannot become a slow query', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      // Seeded directly: initializeTopUp would be TOP_UP_HISTORY_LIMIT + 5
      // round-trips through the gateway mock for no added coverage.
      await mongoConnection.models[TopUpIntent.name].insertMany(
        Array.from({ length: TOP_UP_HISTORY_LIMIT + 5 }, () => ({
          branchId,
          amountCentavos: 10_000,
          status: TopUpIntentStatus.PENDING,
        })),
      );

      const history = await service.topUpHistory(branchId);
      expect(history).toHaveLength(TOP_UP_HISTORY_LIMIT);
    });
  });

  // -------------------------------------------------------------------------
  // WalletAcceptanceGuardService (GAP-P0-004 handoff for Agent 4)
  // -------------------------------------------------------------------------

  describe('WalletAcceptanceGuardService.assertCanAcceptOrder', () => {
    const seedWallet = async (branchId: string, balanceCentavos: number) => {
      await mongoConnection.models[Wallet.name].create({
        branchId,
        balanceCentavos,
      });
    };

    it('[NEG] throws on a negative balance', async () => {
      const branchId = new Types.ObjectId().toString();
      await seedWallet(branchId, -1);
      await expect(guard.assertCanAcceptOrder(branchId, 0)).rejects.toThrow(
        'Wallet balance is negative. Top up before accepting new orders.',
      );
    });

    it('[NEG] throws when the balance cannot cover the estimated fee', async () => {
      const branchId = new Types.ObjectId().toString();
      await seedWallet(branchId, 4_999);
      await expect(guard.assertCanAcceptOrder(branchId, 5_000)).rejects.toThrow(
        "Insufficient wallet balance to cover this order's platform fee.",
      );
    });

    it('[NEG] treats a missing wallet as insufficient', async () => {
      await expect(
        guard.assertCanAcceptOrder(new Types.ObjectId().toString(), 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('[HP] passes when the balance exactly equals the estimated fee', async () => {
      const branchId = new Types.ObjectId().toString();
      await seedWallet(branchId, 5_000);
      await expect(
        guard.assertCanAcceptOrder(branchId, 5_000),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // createWallet idempotency (GAP-M-021)
  // -------------------------------------------------------------------------

  describe('createWallet', () => {
    it('[HP] is an idempotent upsert — a retry cannot duplicate or fail', async () => {
      const branchId = new Types.ObjectId().toString();
      const first = await service.createWallet(branchId);
      const second = await service.createWallet(branchId);
      expect(String(second._id)).toBe(String(first._id));
      const count = await mongoConnection.models[Wallet.name]
        .countDocuments({ branchId })
        .exec();
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // adminAdjustBalance
  // -------------------------------------------------------------------------

  describe('adminAdjustBalance', () => {
    it('[HP] credits the balance and writes a ledger row', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);

      const updated = await service.adminAdjustBalance(branchId, 5_000);

      expect(updated.balanceCentavos).toBe(5_000);
      const entries = await mongoConnection.models[WalletLedgerEntry.name]
        .find({ branchId })
        .exec();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('admin_adjustment');
      expect(entries[0].amountCentavos).toBe(5_000);
      expect(entries[0].balanceAfterCentavos).toBe(5_000);
    });

    it('[HP] debits the balance with a negative delta', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      await service.adminAdjustBalance(branchId, 10_000);

      const updated = await service.adminAdjustBalance(branchId, -4_000);

      expect(updated.balanceCentavos).toBe(6_000);
    });

    it('[EC] rejects a delta of zero', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      await expect(service.adminAdjustBalance(branchId, 0)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('[EC] rejects a debit that would leave the balance negative', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      await service.adminAdjustBalance(branchId, 1_000);

      await expect(
        service.adminAdjustBalance(branchId, -1_001),
      ).rejects.toThrow(BadRequestException);
      expect((await service.getWallet(branchId)).balanceCentavos).toBe(1_000);
    });

    it('[EC] throws NotFoundException for a branch with no wallet', async () => {
      const branchId = new Types.ObjectId().toString();
      await expect(service.adminAdjustBalance(branchId, 1_000)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  describe('reconciliationReport', () => {
    it('[HP] reports zero variance after ledgered top-ups and fee consumption', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      const intent = await service.initializeTopUp(branchId, 100_000, OWNER);
      const intentId = String(intent._id);
      await service.postVerifiedTopUp(intentId, paidEvent(intentId, 100_000));

      const session = await mongoConnection.startSession();
      try {
        await session.withTransaction(async () => {
          await service.consumeFee(branchId, 7_500, 'order-1', session);
        });
      } finally {
        await session.endSession();
      }

      const report = await service.reconciliationReport();
      expect(report.walletsChecked).toBeGreaterThanOrEqual(1);
      expect(report.walletsWithVariance).toBe(0);
      expect(report.variances).toHaveLength(0);
      expect((await service.getWallet(branchId)).balanceCentavos).toBe(92_500);
    });

    it('[NEG] flags a balance mutated outside the ledgered paths', async () => {
      const branchId = await makeBranch();
      await service.createWallet(branchId);
      await mongoConnection.models[Wallet.name]
        .updateOne({ branchId }, { $inc: { balanceCentavos: 123 } })
        .exec();

      const report = await service.reconciliationReport();
      expect(report.walletsWithVariance).toBe(1);
      expect(report.variances[0].branchId).toBe(branchId);
      expect(report.variances[0].varianceCentavos).toBe(123);
    });
  });

  // -------------------------------------------------------------------------
  // TopUpWalletInput validation (GAP-H-033)
  // -------------------------------------------------------------------------

  describe('TopUpWalletInput validation', () => {
    const makeInput = (amountCentavos: unknown) =>
      plainToInstance(TopUpWalletInput, {
        branchId: new Types.ObjectId().toString(),
        amountCentavos,
      });

    it('[NEG] rejects fractional centavos', async () => {
      const errors = await validate(makeInput(100.5));
      expect(errors.some((e) => e.constraints?.isInt)).toBe(true);
    });

    it('[NEG] rejects zero, negative, NaN, and over-max amounts', async () => {
      for (const bad of [0, -100, NaN, 10_000_000_01]) {
        const errors = await validate(makeInput(bad));
        expect(errors.length).toBeGreaterThan(0);
      }
    });

    it('[HP] accepts a positive integer amount', async () => {
      const errors = await validate(makeInput(100_000));
      expect(errors).toHaveLength(0);
    });
  });
});
