import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';

import { WalletsAdminService } from './wallets-admin.service';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntrySchema,
  WalletLedgerEntryType,
} from './schemas/wallet-ledger-entry.schema';
import {
  TopUpIntent,
  TopUpIntentSchema,
  TopUpIntentStatus,
} from './schemas/topup-intent.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import {
  ACTIVATION_MIN_CENTAVOS,
  DISCOVERY_ACCEPT_MIN_CENTAVOS,
} from './wallet.constants';
import { WalletProviderType } from './models/admin-wallet.model';

/**
 * Integration, not unit: every interesting behaviour here is an aggregation
 * across three collections (wallets vs. ledger vs. intents), and a mocked
 * model would only prove the mock agrees with itself.
 */
describe('WalletsAdminService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let mongoConnection: Connection;
  let module: TestingModule;
  let service: WalletsAdminService;

  const makeBranch = async (branchName: string) => {
    const branch = await mongoConnection.models[Branch.name].create({
      uid: `owner-${new Types.ObjectId().toString()}`,
      branchName,
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
      verificationStatus: 'PENDING',
    });
    return String(branch._id);
  };

  const makeWallet = async (
    branchId: string,
    balanceCentavos: number,
    activated = true,
  ) =>
    mongoConnection.models[Wallet.name].create({
      branchId,
      balanceCentavos,
      activatedAt: activated ? new Date() : null,
    });

  const makeLedgerEntry = async (
    branchId: string,
    amountCentavos: number,
    extra: Record<string, unknown> = {},
  ) =>
    mongoConnection.models[WalletLedgerEntry.name].create({
      branchId,
      type:
        amountCentavos >= 0
          ? WalletLedgerEntryType.TOP_UP
          : WalletLedgerEntryType.FEE_CONSUMPTION,
      amountCentavos,
      balanceAfterCentavos: amountCentavos,
      ...extra,
    });

  const makeIntent = async (
    branchId: string,
    amountCentavos: number,
    status: TopUpIntentStatus,
  ) =>
    mongoConnection.models[TopUpIntent.name].create({
      branchId,
      amountCentavos,
      status,
    });

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletLedgerEntry.name, schema: WalletLedgerEntrySchema },
          { name: TopUpIntent.name, schema: TopUpIntentSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
        ]),
      ],
      providers: [WalletsAdminService],
    }).compile();

    service = module.get(WalletsAdminService);
    mongoConnection = module.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      Wallet.name,
      WalletLedgerEntry.name,
      TopUpIntent.name,
      Branch.name,
      WasherProfile.name,
    ]) {
      await mongoConnection.models[name].deleteMany({});
    }
  });

  describe('listWallets', () => {
    it('reports zero variance when the balance matches its ledger', async () => {
      const branchId = await makeBranch('Clean Co');
      await makeWallet(branchId, 50_000);
      await makeLedgerEntry(branchId, 100_000);
      await makeLedgerEntry(branchId, -50_000);

      const page = await service.listWallets();

      expect(page.total).toBe(1);
      expect(page.varianceCount).toBe(0);
      expect(page.data[0]).toMatchObject({
        name: 'Clean Co',
        providerType: WalletProviderType.MERCHANT,
        balanceCentavos: 50_000,
        ledgerBalanceCentavos: 50_000,
        varianceCentavos: 0,
        ledgerEntryCount: 2,
      });
    });

    // The whole reason the page exists: a balance that moved outside the
    // ledgered paths.
    it('surfaces a balance that disagrees with its ledger', async () => {
      const branchId = await makeBranch('Suspect Suds');
      await makeWallet(branchId, 90_000);
      await makeLedgerEntry(branchId, 50_000);

      const page = await service.listWallets();

      expect(page.varianceCount).toBe(1);
      expect(page.data[0].varianceCentavos).toBe(40_000);
    });

    it('sorts the largest variance first, however small its balance', async () => {
      const clean = await makeBranch('Clean');
      await makeWallet(clean, 10_000);
      await makeLedgerEntry(clean, 10_000);

      const broken = await makeBranch('Broken');
      await makeWallet(broken, 1_000);
      await makeLedgerEntry(broken, 500_000);

      const page = await service.listWallets();

      expect(page.data[0].name).toBe('Broken');
    });

    it('computes platform totals over every wallet, not the filtered page', async () => {
      const a = await makeBranch('Alpha');
      await makeWallet(a, 30_000);
      await makeLedgerEntry(a, 30_000);
      const b = await makeBranch('Beta');
      await makeWallet(b, 70_000);
      await makeLedgerEntry(b, 70_000);

      const page = await service.listWallets({ search: 'Alpha' });

      // One row after filtering...
      expect(page.total).toBe(1);
      // ...but the money held on the platform is still both wallets. A total
      // that moved when you typed in the search box would be actively
      // misleading.
      expect(page.totalBalanceCentavos).toBe(100_000);
    });

    it('derives the accept minimum and discovery eligibility from the constants', async () => {
      const rich = await makeBranch('Rich');
      await makeWallet(rich, DISCOVERY_ACCEPT_MIN_CENTAVOS);
      const poor = await makeBranch('Poor');
      await makeWallet(poor, DISCOVERY_ACCEPT_MIN_CENTAVOS - 1);

      const page = await service.listWallets();
      const byName = new Map(page.data.map((r) => [r.name, r]));

      expect(byName.get('Rich')).toMatchObject({
        meetsAcceptMinimum: true,
        walletAllowsDiscovery: true,
      });
      expect(byName.get('Poor')).toMatchObject({
        meetsAcceptMinimum: false,
        walletAllowsDiscovery: false,
      });
    });

    // Activation is one-way: falling back below ₱1,000 does not un-activate
    // her, it only costs her the accept minimum.
    it('keeps a wallet activated after its balance falls below the activation minimum', async () => {
      const branchId = await makeBranch('Once Rich');
      await makeWallet(branchId, ACTIVATION_MIN_CENTAVOS - 1, true);

      const [row] = (await service.listWallets()).data;

      expect(row.activatedAt).not.toBeNull();
      expect(row.meetsAcceptMinimum).toBe(true);
      expect(row.walletAllowsDiscovery).toBe(true);
    });

    it('filters to variances, non-activated and below-minimum wallets', async () => {
      const varianced = await makeBranch('Varianced');
      await makeWallet(varianced, 80_000);
      await makeLedgerEntry(varianced, 10_000);

      const fresh = await makeBranch('Never Activated');
      await makeWallet(fresh, 0, false);

      const healthy = await makeBranch('Healthy');
      await makeWallet(healthy, 200_000);
      await makeLedgerEntry(healthy, 200_000);

      expect(
        (await service.listWallets({ varianceOnly: true })).data,
      ).toHaveLength(1);
      expect(
        (await service.listWallets({ notActivated: true })).data[0].name,
      ).toBe('Never Activated');
      expect(
        (await service.listWallets({ belowAcceptMinimum: true })).data[0].name,
      ).toBe('Never Activated');
    });

    it('names a washer by her store name, not her anchor branch name', async () => {
      const branchId = await makeBranch('Maria Laundry Anchor');
      await mongoConnection.models[WasherProfile.name].create({
        uid: `washer-${new Types.ObjectId().toString()}`,
        branchId,
        displayName: 'Maria Santos',
        storeName: "Maria's Laundry",
      });
      await makeWallet(branchId, 10_000);

      const [row] = (await service.listWallets()).data;

      expect(row.name).toBe("Maria's Laundry");
      expect(row.providerType).toBe(WalletProviderType.WASHER);
    });

    // An orphaned wallet is itself a finding — dropping the row would hide it.
    it('still returns a wallet whose branch no longer exists', async () => {
      await makeWallet('deleted-branch-id', 5_000);

      const [row] = (await service.listWallets()).data;

      expect(row.name).toContain('Unknown provider');
      expect(row.balanceCentavos).toBe(5_000);
    });

    it('counts pending top-ups per wallet', async () => {
      const branchId = await makeBranch('Waiting');
      await makeWallet(branchId, 0, false);
      await makeIntent(branchId, 100_000, TopUpIntentStatus.PENDING);
      await makeIntent(branchId, 50_000, TopUpIntentStatus.PENDING);
      await makeIntent(branchId, 20_000, TopUpIntentStatus.FAILED);

      const [row] = (await service.listWallets()).data;

      expect(row.pendingTopUpCount).toBe(2);
    });
  });

  describe('listTopUps', () => {
    it('flags a settled top-up that never reached a wallet', async () => {
      const branchId = await makeBranch('Missing Money');
      await makeWallet(branchId, 0, false);
      const credited = await makeIntent(
        branchId,
        100_000,
        TopUpIntentStatus.SUCCEEDED,
      );
      const lost = await makeIntent(
        branchId,
        100_000,
        TopUpIntentStatus.SUCCEEDED,
      );
      // The intent's own id is the ledger idempotency reference.
      await makeLedgerEntry(branchId, 100_000, {
        xenditReference: String(credited._id),
      });

      const all = await service.listTopUps();
      const byId = new Map(all.data.map((r) => [String(r.intent._id), r]));

      expect(byId.get(String(credited._id))!.hasLedgerCredit).toBe(true);
      expect(byId.get(String(lost._id))!.hasLedgerCredit).toBe(false);

      const unreconciled = await service.listTopUps({ unreconciledOnly: true });
      expect(unreconciled.total).toBe(1);
      expect(String(unreconciled.data[0].intent._id)).toBe(String(lost._id));
    });

    // A PENDING intent has no credit by definition; it must not be reported as
    // money that went missing.
    it('never reports a pending intent as unreconciled', async () => {
      const branchId = await makeBranch('Mid Checkout');
      await makeWallet(branchId, 0, false);
      await makeIntent(branchId, 100_000, TopUpIntentStatus.PENDING);

      expect((await service.listTopUps({ unreconciledOnly: true })).total).toBe(
        0,
      );
    });

    it('reports a total that matches the filtered set, not the page', async () => {
      const branchId = await makeBranch('Busy');
      await makeWallet(branchId, 0, false);
      for (let i = 0; i < 5; i++) {
        await makeIntent(branchId, 10_000, TopUpIntentStatus.FAILED);
      }

      const page = await service.listTopUps({ limit: 2, offset: 0 });

      expect(page.data).toHaveLength(2);
      expect(page.total).toBe(5);
    });

    it('filters by status and branch', async () => {
      const a = await makeBranch('A');
      const b = await makeBranch('B');
      await makeWallet(a, 0, false);
      await makeWallet(b, 0, false);
      await makeIntent(a, 10_000, TopUpIntentStatus.FAILED);
      await makeIntent(b, 10_000, TopUpIntentStatus.EXPIRED);

      expect(
        (await service.listTopUps({ status: TopUpIntentStatus.FAILED })).total,
      ).toBe(1);
      expect((await service.listTopUps({ branchId: b })).total).toBe(1);
    });
  });

  it('exposes the thresholds from the constants module', () => {
    expect(service.thresholds()).toEqual({
      activationMinCentavos: ACTIVATION_MIN_CENTAVOS,
      acceptMinCentavos: DISCOVERY_ACCEPT_MIN_CENTAVOS,
    });
  });
});
