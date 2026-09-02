// Jest mock assertions like expect(mock.fn) trip @typescript-eslint/unbound-method
// on plain mocked-interface references — safe here, so disabled for this spec.
/* eslint-disable @typescript-eslint/unbound-method */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import {
  migrateCertProofsToPrivate,
  deriveExtension,
} from './cert-proofs-to-private.migration';
import { migrateLegacyOnDelivery } from './legacy-on-delivery.migration';
import { migrateSplitFulfillmentLegs } from './split-fulfillment-legs.migration';
import { auditKycRequiredSet } from './kyc-required-set-audit.migration';
import { repairWasherMapLocation } from './washer-map-location-repair.migration';
import { backfillWasherStoreName } from './washer-store-name-backfill.migration';
import { rewriteStorageHost } from './storage-host-rewrite.migration';
import { migrateScheduledPickupToDayOnly } from './scheduled-pickup-day-only.migration';
import { backfillBranchAccess } from './branch-access-backfill.migration';
import { PERMISSION_CATALOGUE } from '../permissions/permission-catalogue';
import { PERMISSION_GROUP_MEMBERS } from '../permissions/permission-groups';
import { STAFF_DEFAULT_PERMISSION_NAMES } from '../permissions/role-defaults';
import {
  KycDocumentStatus,
  KycDocumentType,
  KycProviderType,
  REQUIRED_KYC_DOCUMENT_TYPES,
} from '../kyc/schemas/kyc-document.schema';
import type { StorageProvider } from '../storage/storage-provider.interface';

describe('data migrations (integration)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let storageMock: jest.Mocked<StorageProvider>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
    await mongod.stop();
  });

  beforeEach(() => {
    storageMock = {
      upload: jest.fn(async (_b, key, _ct) => `https://public.example/${key}`),
      uploadPrivate: jest.fn(async (_b, key, _ct) => key),
      getSignedReadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
      delete: jest.fn(async (_key: string): Promise<void> => {}),
    };
  });

  afterEach(async () => {
    await connection.collection('washer_profiles').deleteMany({});
    await connection.collection('online_orders').deleteMany({});
    await connection.collection('branches').deleteMany({});
    await connection.collection('kyc_documents').deleteMany({});
    await connection.collection('booking_availability_configs').deleteMany({});
    await connection.collection('booking_date_overrides').deleteMany({});
    await connection.collection('users').deleteMany({});
    await connection.collection('activity_logs').deleteMany({});
    await connection.collection('roles').deleteMany({});
    await connection.collection('permissions').deleteMany({});
    await connection.collection('online_orders').deleteMany({});
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Package 2 — public certProofUrls → private evidence store
  // -------------------------------------------------------------------------

  describe('migrateCertProofsToPrivate', () => {
    const fetchObject = jest.fn(async (_url: string) => ({
      buffer: Buffer.from('object-bytes'),
      contentType: 'image/jpeg',
    }));

    const seed = async () => {
      await connection.collection('washer_profiles').insertMany([
        {
          uid: 'washer-1',
          displayName: 'A',
          certProofUrls: [
            'https://public.example/media/a.jpg',
            'https://public.example/media/b.pdf',
          ],
        },
        {
          uid: 'washer-2',
          displayName: 'B',
          certProofUrls: ['https://public.example/media/c.png'],
        },
        // Already private / never uploaded — must be ignored entirely.
        { uid: 'washer-3', displayName: 'C', certProofUrls: [] },
        { uid: 'washer-4', displayName: 'D' },
      ]);
    };

    it('[HP] dry run reports what it would do and writes nothing', async () => {
      await seed();
      const result = await migrateCertProofsToPrivate({
        connection,
        storage: storageMock,
        apply: false,
        fetchObject,
      });

      expect(result.profilesScanned).toBe(2);
      expect(result.objectsCopied).toBe(0);
      expect(result.washerUids.sort()).toEqual(['washer-1', 'washer-2']);
      expect(storageMock.uploadPrivate).not.toHaveBeenCalled();

      const untouched = (await connection
        .collection('washer_profiles')
        .findOne({ uid: 'washer-1' }))!;
      expect(untouched.certProofUrls).toHaveLength(2);
      expect(untouched.certProofObjectKeys).toBeUndefined();
    });

    it('[HP] --apply copies every object privately and retires the public URLs', async () => {
      await seed();
      const result = await migrateCertProofsToPrivate({
        connection,
        storage: storageMock,
        apply: true,
        fetchObject,
      });

      expect(result.profilesScanned).toBe(2);
      expect(result.profilesMigrated).toBe(2);
      expect(result.objectsCopied).toBe(3);
      expect(result.objectsFailed).toBe(0);
      expect(storageMock.uploadPrivate).toHaveBeenCalledTimes(3);

      const w1 = (await connection
        .collection('washer_profiles')
        .findOne({ uid: 'washer-1' }))!;
      expect(w1.certProofUrls).toEqual([]);
      expect(w1.certProofObjectKeys).toHaveLength(2);
      expect(w1.certProofObjectKeys[0]).toMatch(
        /^cert-proofs\/washer\/[a-f0-9]{24}\/[\w-]+\.(jpg|pdf)$/,
      );
      // The retired public URLs are archived, not silently dropped.
      expect(w1.legacyCertProofUrls).toEqual([
        'https://public.example/media/a.jpg',
        'https://public.example/media/b.pdf',
      ]);
    });

    it('[HP] is idempotent — a second run copies nothing and reports 0', async () => {
      await seed();
      await migrateCertProofsToPrivate({
        connection,
        storage: storageMock,
        apply: true,
        fetchObject,
      });
      const before = await connection
        .collection('washer_profiles')
        .find({})
        .sort({ uid: 1 })
        .toArray();

      storageMock.uploadPrivate.mockClear();
      const second = await migrateCertProofsToPrivate({
        connection,
        storage: storageMock,
        apply: true,
        fetchObject,
      });

      expect(second.profilesScanned).toBe(0);
      expect(second.objectsCopied).toBe(0);
      expect(second.washerUids).toEqual([]);
      expect(storageMock.uploadPrivate).not.toHaveBeenCalled();

      const after = await connection
        .collection('washer_profiles')
        .find({})
        .sort({ uid: 1 })
        .toArray();
      expect(after).toEqual(before);
    });

    it('[NP] a failed object is left for the next run, which resumes exactly there', async () => {
      await connection.collection('washer_profiles').insertOne({
        uid: 'washer-1',
        displayName: 'A',
        certProofUrls: [
          'https://public.example/media/ok.jpg',
          'https://public.example/media/gone.jpg',
        ],
      });
      const flaky = jest.fn(async (url: string) => {
        if (url.includes('gone')) throw new Error('404');
        return {
          buffer: Buffer.from('bytes'),
          contentType: 'image/jpeg',
        };
      });

      const first = await migrateCertProofsToPrivate({
        connection,
        storage: storageMock,
        apply: true,
        fetchObject: flaky,
      });
      expect(first.objectsCopied).toBe(1);
      expect(first.objectsFailed).toBe(1);
      expect(first.profilesMigrated).toBe(0);

      const mid = (await connection
        .collection('washer_profiles')
        .findOne({ uid: 'washer-1' }))!;
      expect(mid.certProofUrls).toEqual([
        'https://public.example/media/gone.jpg',
      ]);
      expect(mid.certProofObjectKeys).toHaveLength(1);

      // The object comes back; the re-run finishes the job with no duplicates.
      const second = await migrateCertProofsToPrivate({
        connection,
        storage: storageMock,
        apply: true,
        fetchObject,
      });
      expect(second.objectsCopied).toBe(1);
      const done = (await connection
        .collection('washer_profiles')
        .findOne({ uid: 'washer-1' }))!;
      expect(done.certProofUrls).toEqual([]);
      expect(done.certProofObjectKeys).toHaveLength(2);
    });

    it('[HP] derives the extension from the URL, falling back to content type', () => {
      expect(deriveExtension('https://x/y/a.JPG?token=1', 'image/png')).toBe(
        'jpg',
      );
      expect(deriveExtension('https://x/y/noext', 'application/pdf')).toBe(
        'pdf',
      );
      expect(deriveExtension('https://x/y/noext', 'weird/type')).toBe('bin');
    });
  });

  // -------------------------------------------------------------------------
  // Package 4 — legacy on_delivery payment contract (GAP-P0-028)
  // -------------------------------------------------------------------------

  describe('migrateLegacyOnDelivery', () => {
    const seed = async () => {
      await connection.collection('online_orders').insertMany([
        // Never collected and still live ⇒ genuinely owes money.
        {
          ref: 'legacy-1',
          paymentTiming: 'on_delivery',
          status: 'laundry_ready',
          paymentSummary: { collectedAt: null },
        },
        // Already collected ⇒ the deferral is history, nothing is owed.
        {
          ref: 'legacy-2',
          paymentTiming: 'on_delivery',
          status: 'completed',
          paymentStatus: 'to_pay_on_delivery',
          paymentSummary: { collectedAt: new Date('2026-07-01') },
          pricing: { platformFeeCentavos: 5_000 },
        },
        { ref: 'legacy-3', paymentStatus: 'to_pay_on_delivery' },
        { ref: 'modern-1', paymentTiming: 'on_pickup', paymentStatus: 'paid' },
      ]);
    };

    it('[HP] dry run counts and lists the affected orders without writing', async () => {
      await seed();
      const result = await migrateLegacyOnDelivery({
        connection,
        apply: false,
      });

      expect(result.paymentTimingMatched).toBe(2);
      expect(result.paymentStatusMatched).toBe(2);
      expect(result.paymentTimingUpdated).toBe(0);
      expect(result.affectedOrderIds).toHaveLength(3);

      const stillLegacy = await connection
        .collection('online_orders')
        .countDocuments({ paymentTiming: 'on_delivery' });
      expect(stillLegacy).toBe(2);
    });

    it('[HP] --apply splits the timing mapping by whether anything is still owed', async () => {
      await seed();
      const result = await migrateLegacyOnDelivery({
        connection,
        apply: true,
      });
      expect(result.paymentTimingUpdated).toBe(2);
      expect(result.paymentStatusUpdated).toBe(2);
      expect(result.paymentTimingToHandover).toBe(1);
      expect(result.paymentTimingToPickup).toBe(1);

      const orders = await connection
        .collection('online_orders')
        .find({})
        .sort({ ref: 1 })
        .toArray();
      expect(
        orders.filter((o) => o.paymentTiming === 'on_delivery'),
      ).toHaveLength(0);
      // Uncollected and still live — it really does settle at handover.
      expect(orders.find((o) => o.ref === 'legacy-1')!.paymentTiming).toBe(
        'at_final_handover',
      );
      // Already collected — the deferral is history.
      expect(orders.find((o) => o.ref === 'legacy-2')!.paymentTiming).toBe(
        'on_pickup',
      );
      expect(orders.find((o) => o.ref === 'legacy-2')!.paymentStatus).toBe(
        'unpaid',
      );
      expect(orders.find((o) => o.ref === 'legacy-3')!.paymentStatus).toBe(
        'unpaid',
      );
      // Untouched modern order.
      const modern = orders.find((o) => o.ref === 'modern-1')!;
      expect(modern.paymentTiming).toBe('on_pickup');
      expect(modern.paymentStatus).toBe('paid');
    });

    it('[HP] --apply backfills platformFeeConsumedCentavos on collected orders', async () => {
      await seed();
      const result = await migrateLegacyOnDelivery({
        connection,
        apply: true,
      });
      // Only legacy-2 was ever collected.
      expect(result.feeConsumedBackfillMatched).toBe(1);
      expect(result.feeConsumedBackfillUpdated).toBe(1);

      const collected = await connection
        .collection('online_orders')
        .findOne({ ref: 'legacy-2' });
      // Its fee was debited at pickup, so it must not be debited again when the
      // order is next touched.
      expect(collected!.pricing.platformFeeConsumedCentavos).toBe(5_000);

      const neverCollected = await connection
        .collection('online_orders')
        .findOne({ ref: 'legacy-1' });
      expect(
        neverCollected!.pricing?.platformFeeConsumedCentavos,
      ).toBeUndefined();
    });

    it('[HP] is idempotent — a second run reports 0 changes', async () => {
      await seed();
      await migrateLegacyOnDelivery({ connection, apply: true });
      const before = await connection
        .collection('online_orders')
        .find({})
        .sort({ ref: 1 })
        .toArray();

      const second = await migrateLegacyOnDelivery({ connection, apply: true });
      expect(second).toMatchObject({
        paymentTimingMatched: 0,
        paymentTimingUpdated: 0,
        paymentStatusMatched: 0,
        paymentStatusUpdated: 0,
        affectedOrderIds: [],
      });

      const after = await connection
        .collection('online_orders')
        .find({})
        .sort({ ref: 1 })
        .toArray();
      expect(after).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // Widened KYC required sets — grandfathering audit
  // -------------------------------------------------------------------------

  describe('auditKycRequiredSet', () => {
    const approveAll = async (
      providerId: string,
      types: readonly KycDocumentType[],
    ) =>
      connection.collection('kyc_documents').insertMany(
        types.map((documentType) => ({
          providerId,
          documentType,
          status: KycDocumentStatus.APPROVED,
        })),
      );

    it('[HP] reports an APPROVED branch that predates the widened set, and never downgrades it', async () => {
      const legacy = await connection.collection('branches').insertOne({
        branchName: 'Old Shop',
        verificationStatus: 'APPROVED',
      });
      // Verified under the retired set only.
      await approveAll(String(legacy.insertedId), [
        KycDocumentType.BUSINESS_PERMIT,
        KycDocumentType.OWNER_VALID_ID,
      ]);

      const result = await auditKycRequiredSet({ connection, apply: false });

      expect(result.grandfathered).toHaveLength(1);
      const [row] = result.grandfathered;
      expect(row.providerId).toBe(String(legacy.insertedId));
      expect(row.name).toBe('Old Shop');
      expect(row.missingDocumentTypes).toEqual([
        KycDocumentType.DTI_CERTIFICATE,
        KycDocumentType.BIR_2303,
        KycDocumentType.BUSINESS_PHOTO_STOREFRONT,
        KycDocumentType.BUSINESS_PHOTO_INTERIOR,
        KycDocumentType.BUSINESS_PHOTO_MACHINES,
      ]);
      expect(result.stamped).toBe(0);

      // The badge is untouched — grandfathering, not revocation.
      const branch = await connection
        .collection('branches')
        .findOne({ _id: legacy.insertedId });
      expect(branch!.verificationStatus).toBe('APPROVED');
      expect(branch!.grandfatheredAt).toBeUndefined();
    });

    it('[HP] ignores a provider that already satisfies the current set', async () => {
      const current = await connection.collection('branches').insertOne({
        branchName: 'New Shop',
        verificationStatus: 'APPROVED',
      });
      await approveAll(
        String(current.insertedId),
        REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.MERCHANT_BRANCH],
      );

      const result = await auditKycRequiredSet({ connection, apply: false });
      expect(result.grandfathered).toHaveLength(0);
    });

    it('[HP] --apply stamps grandfatheredAt once and is idempotent', async () => {
      const washer = await connection.collection('washer_profiles').insertOne({
        uid: 'washer-1',
        displayName: 'Ate Baby Laundry',
        verificationStatus: 'APPROVED',
      });
      await approveAll(String(washer.insertedId), [KycDocumentType.VALID_ID]);

      const first = await auditKycRequiredSet({ connection, apply: true });
      expect(first.stamped).toBe(1);
      const stamped = await connection
        .collection('washer_profiles')
        .findOne({ _id: washer.insertedId });
      expect(stamped!.grandfatheredAt).toBeInstanceOf(Date);
      expect(stamped!.verificationStatus).toBe('APPROVED');

      const second = await auditKycRequiredSet({ connection, apply: true });
      expect(second.grandfathered).toHaveLength(1);
      expect(second.stamped).toBe(0);
      const after = await connection
        .collection('washer_profiles')
        .findOne({ _id: washer.insertedId });
      expect(after!.grandfatheredAt).toEqual(stamped!.grandfatheredAt);
    });

    it('[HP] surfaces legacy permits still awaiting review', async () => {
      await connection.collection('kyc_documents').insertOne({
        providerId: 'branch-x',
        documentType: KycDocumentType.BUSINESS_PERMIT,
        status: KycDocumentStatus.SUBMITTED,
      });
      const result = await auditKycRequiredSet({ connection, apply: false });
      expect(result.pendingLegacyPermits).toBe(1);
    });
  });
  // -------------------------------------------------------------------------
  // Malformed WasherProfile.mapLocation — MapLocation.latitude is Float!
  // -------------------------------------------------------------------------

  describe('repairWasherMapLocation', () => {
    const seed = async () => {
      await connection.collection('washer_profiles').insertMany([
        // Every shape that cannot satisfy `MapLocation { latitude: Float! }`.
        { uid: 'bad-empty', mapLocation: {} },
        {
          uid: 'bad-null-lat',
          mapLocation: { latitude: null, longitude: 121 },
        },
        {
          uid: 'bad-null-lng',
          mapLocation: { latitude: 14.5, longitude: null },
        },
        {
          uid: 'bad-string',
          mapLocation: { latitude: '14.5', longitude: '121' },
        },
        {
          uid: 'bad-nan',
          mapLocation: { latitude: Number.NaN, longitude: 121 },
        },
        // Legal shapes — must be left exactly as they are.
        {
          uid: 'good-pin',
          mapLocation: { latitude: 14.5547, longitude: 121.0244 },
        },
        { uid: 'good-null', mapLocation: null },
        { uid: 'good-absent', displayName: 'No pin ever set' },
        // 0,0 is a real coordinate, not a missing one.
        { uid: 'good-zero', mapLocation: { latitude: 0, longitude: 0 } },
      ]);
    };

    it('[HP] dry run lists the malformed profiles without writing', async () => {
      await seed();
      const result = await repairWasherMapLocation({
        connection,
        apply: false,
      });

      expect(result.matched).toBe(5);
      expect(result.updated).toBe(0);
      expect(result.affected.map((a) => a.uid).sort()).toEqual([
        'bad-empty',
        'bad-nan',
        'bad-null-lat',
        'bad-null-lng',
        'bad-string',
      ]);

      const untouched = await connection
        .collection('washer_profiles')
        .findOne({ uid: 'bad-empty' });
      expect(untouched!.mapLocation).toEqual({});
    });

    it('[HP] --apply clears malformed pins and leaves valid ones alone', async () => {
      await seed();
      const result = await repairWasherMapLocation({ connection, apply: true });
      expect(result.updated).toBe(5);

      const profiles = await connection
        .collection('washer_profiles')
        .find({})
        .toArray();
      const byUid = new Map(profiles.map((p) => [p.uid, p]));

      for (const uid of [
        'bad-empty',
        'bad-null-lat',
        'bad-null-lng',
        'bad-string',
        'bad-nan',
      ]) {
        expect(byUid.get(uid)!.mapLocation).toBeNull();
      }
      expect(byUid.get('good-pin')!.mapLocation).toEqual({
        latitude: 14.5547,
        longitude: 121.0244,
      });
      // A pin at the origin is valid data, not a missing coordinate.
      expect(byUid.get('good-zero')!.mapLocation).toEqual({
        latitude: 0,
        longitude: 0,
      });
      expect(byUid.get('good-absent')!.mapLocation).toBeUndefined();
    });

    it('[HP] is idempotent — a second run reports 0 changes', async () => {
      await seed();
      await repairWasherMapLocation({ connection, apply: true });
      const second = await repairWasherMapLocation({ connection, apply: true });
      expect(second).toMatchObject({ matched: 0, updated: 0, affected: [] });
    });
  });

  describe('backfillWasherStoreName', () => {
    const seed = async () => {
      await connection.collection('branches').insertMany([
        { _id: 'anchor-maria' as never, branchName: "Maria's Laundry" },
        { _id: 'anchor-blank' as never, branchName: '   ' },
      ]);
      await connection
        .collection('users')
        .insertOne({ _id: 'uid-nena' as never, firstName: 'Nena' });
      await connection.collection('washer_profiles').insertMany([
        // Needs a name — takes it from the anchor branch.
        {
          uid: 'uid-maria',
          displayName: 'Maria Dela Cruz',
          branchId: 'anchor-maria',
        },
        // Branch name unusable → recomputed from the User's first name.
        {
          uid: 'uid-nena',
          displayName: 'Nena Reyes',
          branchId: 'anchor-blank',
          storeName: null,
        },
        // No branch and no user row → first word of displayName, never the
        // whole legal name.
        { uid: 'uid-orphan', displayName: 'Rita Santos', storeName: '' },
        // Nothing to build from at all.
        { uid: 'uid-bare', displayName: '', storeName: '   ' },
        // Already named — must be left exactly as it is.
        {
          uid: 'uid-named',
          displayName: 'Ana Cruz',
          branchId: 'anchor-maria',
          storeName: 'Bubbles & Co',
        },
      ]);
    };

    const namesByUid = async () => {
      const docs = await connection
        .collection('washer_profiles')
        .find({})
        .toArray();
      return new Map(docs.map((d) => [d.uid as string, d.storeName]));
    };

    it('[HP] dry run lists the profiles and their names without writing', async () => {
      await seed();
      const result = await backfillWasherStoreName({
        connection,
        apply: false,
      });

      expect(result.matched).toBe(4);
      expect(result.updated).toBe(0);
      expect(
        result.affected.map((a) => [a.uid, a.storeName, a.source]).sort(),
      ).toEqual([
        ['uid-bare', 'Home Laundry', 'generic'],
        ['uid-maria', "Maria's Laundry", 'branch'],
        ['uid-nena', "Nena's Laundry", 'firstName'],
        ['uid-orphan', "Rita's Laundry", 'displayName'],
      ]);

      const stored = await namesByUid();
      expect(stored.get('uid-maria')).toBeUndefined();
    });

    it('[HP] --apply writes each name and leaves a named shop alone', async () => {
      await seed();
      const result = await backfillWasherStoreName({ connection, apply: true });
      expect(result.updated).toBe(4);

      const stored = await namesByUid();
      expect(stored.get('uid-maria')).toBe("Maria's Laundry");
      expect(stored.get('uid-nena')).toBe("Nena's Laundry");
      expect(stored.get('uid-orphan')).toBe("Rita's Laundry");
      expect(stored.get('uid-bare')).toBe('Home Laundry');
      expect(stored.get('uid-named')).toBe('Bubbles & Co');
    });

    it('[EC] never writes a washer’s full legal name as her shop name', async () => {
      await seed();
      const result = await backfillWasherStoreName({ connection, apply: true });
      const names = result.affected.map((a) => a.storeName);
      for (const legal of ['Maria Dela Cruz', 'Nena Reyes', 'Rita Santos']) {
        expect(names).not.toContain(legal);
      }
    });

    it('[HP] is idempotent — a second run reports 0 changes', async () => {
      await seed();
      await backfillWasherStoreName({ connection, apply: true });
      const second = await backfillWasherStoreName({
        connection,
        apply: true,
      });
      expect(second).toMatchObject({ matched: 0, updated: 0, affected: [] });
    });
  });

  describe('migrateSplitFulfillmentLegs', () => {
    const day = (fulfillment: Record<string, unknown>) => ({
      isAcceptingBookings: true,
      windows: [{ start: '08:00', end: '20:00' }],
      fulfillment,
    });

    const seed = async () => {
      await connection.collection('booking_availability_configs').insertMany([
        {
          branchId: 'legacy-on',
          weekly: {
            monday: day({ pickupAndDelivery: true, customerDropoff: true }),
            tuesday: day({ pickupAndDelivery: false, customerDropoff: true }),
          },
        },
        {
          // Already split — must not be touched.
          branchId: 'modern',
          weekly: {
            monday: day({ providerPickup: true, providerDelivery: false }),
          },
        },
      ]);
      await connection.collection('booking_date_overrides').insertMany([
        {
          branchId: 'legacy-on',
          date: '2026-09-01',
          fulfillment: { pickupAndDelivery: false },
        },
        {
          branchId: 'modern',
          date: '2026-09-02',
          fulfillment: { providerPickup: true },
        },
      ]);
    };

    it('[HP] dry run counts the legacy documents without writing', async () => {
      await seed();
      const result = await migrateSplitFulfillmentLegs({
        connection,
        apply: false,
      });

      expect(result.configsMatched).toBe(1);
      expect(result.overridesMatched).toBe(1);
      expect(result.configsUpdated).toBe(0);
      expect(result.overridesUpdated).toBe(0);

      const doc = await connection
        .collection('booking_availability_configs')
        .findOne({ branchId: 'legacy-on' });
      expect(doc?.weekly.monday.fulfillment.pickupAndDelivery).toBe(true);
      expect(doc?.weekly.monday.fulfillment.providerPickup).toBeUndefined();
    });

    it('[HP] --apply gives both legs the legacy value and drops the old field', async () => {
      await seed();
      const result = await migrateSplitFulfillmentLegs({
        connection,
        apply: true,
      });
      expect(result.configsUpdated).toBe(1);
      expect(result.overridesUpdated).toBe(1);

      const doc = await connection
        .collection('booking_availability_configs')
        .findOne({ branchId: 'legacy-on' });

      // A provider who offered both yesterday still offers both.
      expect(doc?.weekly.monday.fulfillment).toMatchObject({
        providerPickup: true,
        providerDelivery: true,
      });
      // ...and one who offered neither still offers neither.
      expect(doc?.weekly.tuesday.fulfillment).toMatchObject({
        providerPickup: false,
        providerDelivery: false,
      });
      expect(doc?.weekly.monday.fulfillment.pickupAndDelivery).toBeUndefined();

      const override = await connection
        .collection('booking_date_overrides')
        .findOne({ branchId: 'legacy-on' });
      expect(override?.fulfillment).toMatchObject({
        providerPickup: false,
        providerDelivery: false,
      });
    });

    it('[EC] leaves already-split documents untouched', async () => {
      await seed();
      await migrateSplitFulfillmentLegs({ connection, apply: true });

      const doc = await connection
        .collection('booking_availability_configs')
        .findOne({ branchId: 'modern' });
      expect(doc?.weekly.monday.fulfillment).toMatchObject({
        providerPickup: true,
        providerDelivery: false,
      });
    });

    it('[EC] is idempotent — a second run matches nothing', async () => {
      await seed();
      await migrateSplitFulfillmentLegs({ connection, apply: true });
      const second = await migrateSplitFulfillmentLegs({
        connection,
        apply: true,
      });
      expect(second.configsMatched).toBe(0);
      expect(second.overridesMatched).toBe(0);
      expect(second.affectedIds).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Storage URLs are persisted absolute. Under the emulator the host comes
  // from FIREBASE_STORAGE_EMULATOR_HOST, so `localhost:9199` bakes a
  // client-relative host into the database: readable from the iOS simulator,
  // connection-refused from an Android emulator and from real devices.
  // -------------------------------------------------------------------------

  describe('storage host rewrite', () => {
    const OLD = 'localhost:9199';
    const NEW = '10.250.1.125:9199';
    const url = (host: string, key: string) =>
      `http://${host}/v0/b/bucket.firebasestorage.app/o/${encodeURIComponent(key)}?alt=media`;

    const seed = async () => {
      await connection.collection('washer_profiles').insertOne({
        uid: 'w1',
        photoUrl: url(OLD, 'profiles/washers/w1/selfie.jpg'),
        logoUrl: url(OLD, 'profiles/washers/w1/selfie.jpg'),
        coverPhotoUrl: null,
        featuredPhotos: [url(OLD, 'a.jpg'), url(OLD, 'b.jpg')],
      });
      await connection.collection('users').insertOne({
        uid: 'u1',
        photoUrl: url(OLD, 'users/u1/avatar.jpg'),
      });
    };

    it('[HP] repoints every URL field, arrays included', async () => {
      await seed();

      const res = await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: true,
      });

      expect(res.updated).toBe(2);
      const w = await connection
        .collection('washer_profiles')
        .findOne({ uid: 'w1' });
      expect(w?.photoUrl).toContain(NEW);
      expect(w?.logoUrl).toContain(NEW);
      expect(w?.featuredPhotos).toEqual([url(NEW, 'a.jpg'), url(NEW, 'b.jpg')]);
      const u = await connection.collection('users').findOne({ uid: 'u1' });
      expect(u?.photoUrl).toContain(NEW);
    });

    // Only the host segment is wrong. The percent-encoded object key and the
    // ?alt=media query must survive byte-for-byte, or the URL 404s.
    it('[HP] preserves the object key, its encoding and the query string', async () => {
      await seed();

      await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: true,
      });

      const w = await connection
        .collection('washer_profiles')
        .findOne({ uid: 'w1' });
      expect(w?.photoUrl).toBe(url(NEW, 'profiles/washers/w1/selfie.jpg'));
      expect(String(w?.photoUrl)).toContain('%2F');
      expect(String(w?.photoUrl)).toContain('?alt=media');
    });

    it('[HP] a dry run reports the work and writes nothing', async () => {
      await seed();

      const res = await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: false,
      });

      expect(res.matched).toBe(2);
      expect(res.updated).toBe(0);
      const w = await connection
        .collection('washer_profiles')
        .findOne({ uid: 'w1' });
      expect(w?.photoUrl).toContain(OLD);
    });

    it('[HP] is idempotent — the second run matches nothing', async () => {
      await seed();

      await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: true,
      });
      const second = await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: true,
      });

      expect(second.matched).toBe(0);
      expect(second.updated).toBe(0);
    });

    it('[HP] reverses cleanly when the hosts are swapped', async () => {
      await seed();

      await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: true,
      });
      await rewriteStorageHost({
        connection,
        fromHost: NEW,
        toHost: OLD,
        apply: true,
      });

      const w = await connection
        .collection('washer_profiles')
        .findOne({ uid: 'w1' });
      expect(w?.photoUrl).toBe(url(OLD, 'profiles/washers/w1/selfie.jpg'));
    });

    // activity_logs records the URL that was actually issued at the time.
    // Rewriting it would make the audit trail lie about what happened.
    it('[HP] leaves the audit trail alone', async () => {
      const historical = url(OLD, 'profiles/washers/w1/selfie.jpg');
      await connection.collection('activity_logs').insertOne({
        action: 'SELFIE_UPLOADED',
        metadata: { photoUrl: historical },
      });
      await seed();

      await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: true,
      });

      const log = await connection.collection('activity_logs').findOne({});
      expect(log?.metadata).toEqual({ photoUrl: historical });
    });

    it('[HP] leaves null and production GCS URLs untouched', async () => {
      const gcs =
        'https://storage.googleapis.com/bucket/profiles/w2/selfie.jpg';
      await connection.collection('washer_profiles').insertOne({
        uid: 'w2',
        photoUrl: gcs,
        logoUrl: null,
        featuredPhotos: [],
      });

      const res = await rewriteStorageHost({
        connection,
        fromHost: OLD,
        toHost: NEW,
        apply: true,
      });

      expect(res.matched).toBe(0);
      const w = await connection
        .collection('washer_profiles')
        .findOne({ uid: 'w2' });
      expect(w?.photoUrl).toBe(gcs);
      expect(w?.logoUrl).toBeNull();
    });

    it('[NE] refuses a no-op rewrite rather than scanning for nothing', async () => {
      await expect(
        rewriteStorageHost({
          connection,
          fromHost: OLD,
          toHost: OLD,
          apply: true,
        }),
      ).rejects.toThrow(/nothing to rewrite/);
    });

    it('[NE] refuses a host passed with a scheme', async () => {
      await expect(
        rewriteStorageHost({
          connection,
          fromHost: `http://${OLD}`,
          toHost: NEW,
          apply: true,
        }),
      ).rejects.toThrow(/without the scheme/);
    });
  });

  // -------------------------------------------------------------------------
  // scheduledPickup: 30-minute window → day only.
  //
  // The gate that matters is that `date` SURVIVES: day capacity is counted by
  // grouping orders on that field, so losing it would silently free every
  // existing booking's place in its provider's day.
  // -------------------------------------------------------------------------

  describe('scheduled pickup → day only', () => {
    const seedWindowed = async () => {
      await connection.collection('online_orders').insertMany([
        {
          'provider.branchId': 'b1',
          fulfillment: {
            scheduledPickup: {
              date: '2026-08-18',
              startTime: '08:00',
              endTime: '08:30',
              label: '8:00 AM – 8:30 AM',
            },
          },
        },
        {
          'provider.branchId': 'b1',
          fulfillment: {
            scheduledPickup: {
              date: '2026-12-25',
              startTime: '14:30',
              endTime: '15:00',
              label: '2:30 PM – 3:00 PM',
            },
          },
        },
      ]);
    };

    it('[HP] keeps the date and drops only the times', async () => {
      await seedWindowed();

      const res = await migrateScheduledPickupToDayOnly({
        connection,
        apply: true,
      });

      expect(res.updated).toBe(2);
      const docs = await connection
        .collection('online_orders')
        .find({})
        .sort({ 'fulfillment.scheduledPickup.date': 1 })
        .toArray();
      expect(docs[0].fulfillment.scheduledPickup).toEqual({
        date: '2026-08-18',
        label: 'Tue, Aug 18',
      });
      expect(docs[1].fulfillment.scheduledPickup).toEqual({
        date: '2026-12-25',
        label: 'Fri, Dec 25',
      });
    });

    it('[HP] a dry run reports the work and writes nothing', async () => {
      await seedWindowed();

      const res = await migrateScheduledPickupToDayOnly({
        connection,
        apply: false,
      });

      expect(res.matched).toBe(2);
      expect(res.updated).toBe(0);
      const doc = await connection.collection('online_orders').findOne({});
      expect(doc?.fulfillment.scheduledPickup.startTime).toBe('08:00');
    });

    it('[HP] is idempotent — the second run matches nothing', async () => {
      await seedWindowed();
      await migrateScheduledPickupToDayOnly({ connection, apply: true });

      const second = await migrateScheduledPickupToDayOnly({
        connection,
        apply: true,
      });

      expect(second.matched).toBe(0);
      expect(second.updated).toBe(0);
    });

    // Unsetting the times on a dateless order would leave it counting toward
    // no day at all — worse than the state it is already in.
    it('[EC] refuses to touch a window that has no date', async () => {
      await connection.collection('online_orders').insertOne({
        'provider.branchId': 'b1',
        fulfillment: {
          scheduledPickup: { startTime: '08:00', endTime: '08:30' },
        },
      });

      const res = await migrateScheduledPickupToDayOnly({
        connection,
        apply: true,
      });

      expect(res.undatable).toHaveLength(1);
      expect(res.updated).toBe(0);
      const doc = await connection.collection('online_orders').findOne({});
      expect(doc?.fulfillment.scheduledPickup.startTime).toBe('08:00');
    });

    it('[HP] leaves an already-migrated order alone', async () => {
      await connection.collection('online_orders').insertOne({
        'provider.branchId': 'b1',
        fulfillment: {
          scheduledPickup: { date: '2026-08-18', label: 'Tue, Aug 18' },
        },
      });

      const res = await migrateScheduledPickupToDayOnly({
        connection,
        apply: true,
      });

      expect(res.matched).toBe(0);
    });
  });
  // ═══════════════════════════════════════════════════════════════════════════
  // branchAccess backfill
  // ═══════════════════════════════════════════════════════════════════════════

  describe('backfillBranchAccess', () => {
    const OWNER = 'merchant-uid-1';
    let staffRoleId: mongoose.Types.ObjectId;
    let courierRoleId: mongoose.Types.ObjectId;
    let idByName: Map<string, mongoose.Types.ObjectId>;

    const branchA = new mongoose.Types.ObjectId();
    const branchB = new mongoose.Types.ObjectId();

    beforeEach(async () => {
      staffRoleId = new mongoose.Types.ObjectId();
      courierRoleId = new mongoose.Types.ObjectId();
      await connection.collection('roles').insertMany([
        { _id: staffRoleId, roleId: 'staff', roleName: 'Staff' },
        { _id: courierRoleId, roleId: 'courier', roleName: 'Courier' },
      ] as never);
      const rows = PERMISSION_CATALOGUE.map((p) => ({
        _id: new mongoose.Types.ObjectId(),
        permissionName: p.permissionName,
        description: p.description,
      }));
      await connection.collection('permissions').insertMany(rows);
      idByName = new Map(rows.map((r) => [r.permissionName, r._id]));
    });

    const seedStaff = async (
      uid: string,
      permissionNames: string[],
      branchIds: mongoose.Types.ObjectId[] = [branchA],
      role = staffRoleId,
    ) =>
      connection.collection('users').insertOne({
        _id: uid,
        email: `${uid}@example.com`,
        role,
        merchantId: OWNER,
        branchIds,
        permissionIds: permissionNames.map((n) => idByName.get(n)!),
      } as never);

    const load = async (uid: string) =>
      connection.collection('users').findOne({ _id: uid } as never);

    it('writes the old implicit floor down so nobody silently loses access', async () => {
      // The floor was never stored — the guard granted it. Deleting the floor
      // without this step would strip every existing staff member.
      await seedStaff('s1', []);

      await backfillBranchAccess({ connection, apply: true, exact: true });

      const doc = await load('s1');
      const granted = doc!.branchAccess[0].permissionIds.map(String);
      for (const name of STAFF_DEFAULT_PERMISSION_NAMES) {
        expect(granted).toContain(String(idByName.get(name)));
      }
    });

    it('copies grants onto every assigned branch — account-global semantics preserved', async () => {
      await seedStaff('s1', ['order_create'], [branchA, branchB]);

      await backfillBranchAccess({ connection, apply: true, exact: true });

      const doc = await load('s1');
      expect(doc!.branchAccess).toHaveLength(2);
      const [a, b] = doc!.branchAccess;
      expect(a.permissionIds.map(String).sort()).toEqual(
        b.permissionIds.map(String).sort(),
      );
    });

    it('expands partial holdings to whole groups by default', async () => {
      await seedStaff('s1', []);

      await backfillBranchAccess({ connection, apply: true });

      const doc = await load('s1');
      const granted = doc!.branchAccess[0].permissionIds.map(String);
      // The floor is a partial ORDERS + partial INVENTORY, so both widen.
      for (const name of [
        ...PERMISSION_GROUP_MEMBERS.ORDERS,
        ...PERMISSION_GROUP_MEMBERS.INVENTORY,
      ]) {
        expect(granted).toContain(String(idByName.get(name)));
      }
      // Untouched groups stay off.
      for (const name of PERMISSION_GROUP_MEMBERS.SERVICES) {
        expect(granted).not.toContain(String(idByName.get(name)));
      }
    });

    it('reports the privilege it would widen, before anything is written', async () => {
      await seedStaff('s1', []);

      const result = await backfillBranchAccess({ connection, apply: false });

      expect(result.escalations.order_cancel).toBe(1);
      expect(result.escalations.order_apply_discount).toBe(1);
      // A dry run writes nothing.
      const doc = await load('s1');
      expect(doc!.branchAccess).toBeUndefined();
    });

    it('--exact widens nothing', async () => {
      await seedStaff('s1', []);

      const result = await backfillBranchAccess({
        connection,
        apply: true,
        exact: true,
      });

      expect(result.escalations).toEqual({});
      const doc = await load('s1');
      expect(doc!.branchAccess[0].permissionIds).toHaveLength(
        STAFF_DEFAULT_PERMISSION_NAMES.length,
      );
    });

    it('gives couriers branch entries granting nothing', async () => {
      await seedStaff('c1', [], [branchA], courierRoleId);

      await backfillBranchAccess({ connection, apply: true });

      const doc = await load('c1');
      expect(doc!.branchAccess).toHaveLength(1);
      expect(doc!.branchAccess[0].permissionIds).toEqual([]);
      // branchIds stays a true mirror so assertAssignableCourier keeps working.
      expect(doc!.branchIds.map(String)).toEqual([String(branchA)]);
    });

    it('leaves staff with no branches holding nothing', async () => {
      await seedStaff('s1', ['order_create'], []);

      await backfillBranchAccess({ connection, apply: true });

      const doc = await load('s1');
      expect(doc!.branchAccess).toEqual([]);
      expect(doc!.permissionIds).toEqual([]);
    });

    it('mirrors permissionIds as the union of the branch grants', async () => {
      await seedStaff('s1', ['order_create'], [branchA, branchB]);

      await backfillBranchAccess({ connection, apply: true, exact: true });

      const doc = await load('s1');
      const union = new Set(doc!.permissionIds.map(String));
      const perBranch = new Set(
        doc!.branchAccess.flatMap((e: any) =>
          e.permissionIds.map((p: unknown) => String(p)),
        ),
      );
      expect([...union].sort()).toEqual([...perBranch].sort());
    });

    it('is idempotent — a second run matches nothing', async () => {
      await seedStaff('s1', ['order_create']);

      const first = await backfillBranchAccess({ connection, apply: true });
      const second = await backfillBranchAccess({ connection, apply: true });

      expect(first.updated).toBe(1);
      expect(second.matched).toBe(0);
      expect(second.updated).toBe(0);
    });
  });
});
