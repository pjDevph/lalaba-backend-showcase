// Jest mock assertions like expect(mock.fn) trip @typescript-eslint/unbound-method
// on plain mocked-interface references — safe here, so disabled for this spec.
/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KycService } from './kyc.service';
import {
  KycDocument,
  KycDocumentSchema,
  KycDocumentStatus,
  KycDocumentType,
  KycRejectionReason,
  KYC_REJECTION_REASON_TEXT,
  KycExpiryPolicy,
  KycProviderType,
  KYC_DOCUMENT_EXPIRY_POLICY,
  REQUIRED_KYC_DOCUMENT_TYPES,
  GovernmentIdType,
  GOVERNMENT_ID_DOCUMENT_TYPES,
  requiredKycDocumentTypes,
} from './schemas/kyc-document.schema';
import {
  KycAuditEvent,
  KycAuditEventSchema,
  KycAuditEventType,
} from './schemas/kyc-audit-event.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { LivenessChallenge } from '../courier-verification/schemas/courier-selfie.schema';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';
import { User, UserSchema } from '../users/schemas/user.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeUser = (uid: string, roleId: string): User =>
  ({ _id: uid, role: { roleId } }) as unknown as User;

// A real 1x1 PNG, not a placeholder string. It has to start with the actual PNG
// magic bytes: submitting a SELFIE republishes it as the washer's public avatar,
// and that path content-checks the bytes against the declared MIME type.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

// Types whose expiry policy is REQUIRED can't be submitted without a date, so
// the shared helpers below supply a far-future one. Tests that care about
// expiry pass their own.
const defaultExpiryFor = (documentType: KycDocumentType) =>
  KYC_DOCUMENT_EXPIRY_POLICY[documentType] === KycExpiryPolicy.REQUIRED
    ? daysFromNow(365)
    : undefined;

// Same idea for the front-of-ID types, which can't be submitted without a
// claimed ID type. A two-sided default, so the required set stays the full one
// unless a test deliberately asks for a passport.
const defaultIdTypeFor = (documentType: KycDocumentType) =>
  GOVERNMENT_ID_DOCUMENT_TYPES.includes(documentType)
    ? GovernmentIdType.DRIVERS_LICENSE
    : undefined;

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

const makeBranch = (uid: string, name = 'Main Branch') => ({
  uid,
  branchName: name,
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('KycService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: KycService;
  let module: TestingModule;
  let storageMock: jest.Mocked<StorageProvider>;
  let notificationsMock: { sendToUser: jest.Mock; notify: jest.Mock };
  let usersMock: { invalidateUserCache: jest.Mock };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    notificationsMock = {
      sendToUser: jest.fn(async () => undefined),
      notify: jest.fn(async () => undefined),
    };
    usersMock = { invalidateUserCache: jest.fn(async () => undefined) };
    storageMock = {
      upload: jest.fn(async (_b, key, _ct) => `https://public.example/${key}`),
      uploadPrivate: jest.fn(async (_b, key, _ct) => key),
      getSignedReadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
      delete: jest.fn(async (_key: string): Promise<void> => {}),
    };
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: KycDocument.name, schema: KycDocumentSchema },
          { name: KycAuditEvent.name, schema: KycAuditEventSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: User.name, schema: UserSchema },
        ]),
      ],
      providers: [
        KycService,
        { provide: STORAGE_PROVIDER, useValue: storageMock },
        // Decisions push the outcome to the provider's owner. Mocked rather
        // than wired to Firebase — this suite is about lifecycle state, and a
        // real messaging client would need credentials to instantiate.
        { provide: NotificationsService, useValue: notificationsMock },
        // Publishing a washer's selfie as her avatar has to drop the cached
        // user document, or the guard serves the old photo for the rest of the
        // TTL. Only that one method is used here.
        { provide: UsersService, useValue: usersMock },
      ],
    }).compile();

    service = module.get<KycService>(KycService);
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

  const washerUser = makeUser('washer-1', 'washer');
  const otherWasherUser = makeUser('washer-2', 'washer');
  const merchantUser = makeUser('merchant-1', 'merchant');
  const adminUser = makeUser('admin-1', 'admin');
  const supportUser = makeUser('support-1', 'support');

  const createWasherProfile = async (uid: string) =>
    mongoConnection
      .model(WasherProfile.name)
      .create({ uid, displayName: `Washer ${uid}`, branchId: `anchor-${uid}` });

  const createBranch = async (uid: string) =>
    mongoConnection.model(Branch.name).create(makeBranch(uid));

  const submitWasherDoc = (
    user: User,
    documentType: KycDocumentType,
    providerId?: string,
    governmentIdType = defaultIdTypeFor(documentType),
  ) =>
    service.submitDocument(user, {
      providerType: KycProviderType.WASHER,
      providerId,
      documentType,
      base64: PNG_BASE64,
      mimeType: 'image/png',
      expiresAt: defaultExpiryFor(documentType),
      governmentIdType,
    });

  const submitBranchDoc = (
    user: User,
    branchId: string,
    documentType: KycDocumentType,
  ) =>
    service.submitDocument(user, {
      providerType: KycProviderType.MERCHANT_BRANCH,
      providerId: branchId,
      documentType,
      base64: PNG_BASE64,
      mimeType: 'image/png',
      expiresAt: defaultExpiryFor(documentType),
      governmentIdType: defaultIdTypeFor(documentType),
    });

  // -------------------------------------------------------------------------
  // submit
  // -------------------------------------------------------------------------

  describe('submitDocument', () => {
    it('[HP] stores a private object under a server-derived kyc/ key and records an audit event', async () => {
      const profile = await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      expect(doc.status).toBe(KycDocumentStatus.SUBMITTED);
      expect(doc.providerId).toBe(String(profile._id));
      expect(doc.ownerUid).toBe('washer-1');
      expect(storageMock.uploadPrivate).toHaveBeenCalledTimes(1);
      expect(storageMock.upload).not.toHaveBeenCalled();
      const key = storageMock.uploadPrivate.mock.calls[0][1];
      expect(key).toMatch(
        new RegExp(`^kyc/washer/${profile._id}/valid_id/[0-9a-f-]+\\.png$`),
      );

      const audits = await mongoConnection
        .collection('kyc_audit_events')
        .find({ event: KycAuditEventType.DOCUMENT_SUBMITTED })
        .toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].actorUid).toBe('washer-1');
    });

    it('[NP] rejects a document type that does not apply to the provider type', async () => {
      await createWasherProfile('washer-1');
      await expect(
        submitWasherDoc(washerUser, KycDocumentType.BUSINESS_PERMIT),
      ).rejects.toThrow(BadRequestException);
    });

    it('[NP] rejects unsupported MIME types', async () => {
      await createWasherProfile('washer-1');
      await expect(
        service.submitDocument(washerUser, {
          providerType: KycProviderType.WASHER,
          documentType: KycDocumentType.VALID_ID,
          base64: PNG_BASE64,
          mimeType: 'application/x-msdownload',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    // The washer app captures a selfie through the same liveness check couriers
    // pass and reports its verdict here. The server cannot re-derive any of it —
    // it is stored for the reviewer and for nothing else.
    describe('liveness verdict', () => {
      const liveness = {
        livenessChallenge: LivenessChallenge.BLINK,
        livenessMetadata: {
          durationMs: 4200,
          eyesOpenScore: 0.94,
          yawDegrees: 1.5,
          pitchDegrees: -2,
          attemptCount: 1,
        },
      };

      it('[HP] records the challenge and metadata against a selfie', async () => {
        await createWasherProfile('washer-1');
        const doc = await service.submitDocument(washerUser, {
          providerType: KycProviderType.WASHER,
          documentType: KycDocumentType.SELFIE,
          base64: PNG_BASE64,
          mimeType: 'image/png',
          ...liveness,
        });

        expect(doc.livenessChallenge).toBe(LivenessChallenge.BLINK);
        expect(doc.livenessMetadata?.eyesOpenScore).toBe(0.94);
        expect(doc.livenessMetadata?.attemptCount).toBe(1);
      });

      it('[HP] a selfie submitted without one is still accepted', async () => {
        await createWasherProfile('washer-1');
        const doc = await submitWasherDoc(washerUser, KycDocumentType.SELFIE);

        expect(doc.status).toBe(KycDocumentStatus.SUBMITTED);
        expect(doc.livenessChallenge ?? null).toBeNull();
        expect(doc.livenessMetadata ?? null).toBeNull();
      });

      it('[NP] drops it from a document type that is not a face', async () => {
        await createWasherProfile('washer-1');
        const doc = await service.submitDocument(washerUser, {
          providerType: KycProviderType.WASHER,
          documentType: KycDocumentType.VALID_ID,
          base64: PNG_BASE64,
          mimeType: 'image/png',
          governmentIdType: GovernmentIdType.DRIVERS_LICENSE,
          ...liveness,
        });

        expect(doc.livenessChallenge ?? null).toBeNull();
        expect(doc.livenessMetadata ?? null).toBeNull();
      });
    });

    it('[HP] accepts DOCX on the evidence path (GAP-M-020)', async () => {
      await createWasherProfile('washer-1');
      const doc = await service.submitDocument(washerUser, {
        providerType: KycProviderType.WASHER,
        documentType: KycDocumentType.BARANGAY_CLEARANCE,
        base64: PNG_BASE64,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        expiresAt: daysFromNow(365),
      });
      expect(doc.storageObjectKey).toMatch(/\.docx$/);
    });

    // A washer's selfie becomes her public face immediately, without a
    // reviewer — mirroring the courier flow. The private evidence copy is
    // unaffected and still reviewed.
    describe('washer selfie → public photo', () => {
      // `mongoConnection.model()` is untyped and lean() is nullable, so these
      // read helpers do the narrowing once instead of at every assertion.
      type WasherRow = {
        photoUrl?: string | null;
        logoUrl?: string | null;
        selfiePublicObjectKey?: string | null;
        verificationStatus?: string;
      };
      const readWasher = async (id: unknown): Promise<WasherRow> =>
        (await mongoConnection
          .model(WasherProfile.name)
          .findById(id)
          .lean()) as unknown as WasherRow;

      const readUser = async (
        id: string,
      ): Promise<{ photoUrl?: string | null; selfieStatus?: string | null }> =>
        (await mongoConnection
          .model(User.name)
          .findById(id)
          .lean()) as unknown as {
          photoUrl?: string | null;
          selfieStatus?: string | null;
        };

      it('[HP] publishes the selfie as avatar and store logo, unapproved', async () => {
        const profile = await createWasherProfile('washer-1');
        await mongoConnection.model(User.name).create({
          _id: 'washer-1',
          email: 'w@example.com',
          firstName: 'Maria',
          lastName: 'Santos',
          phoneNumber: '09171234567',
          role: new Types.ObjectId(),
        });

        await submitWasherDoc(washerUser, KycDocumentType.SELFIE);

        const updated = await readWasher(profile._id);
        expect(updated.photoUrl).toMatch(/^https:\/\/public\.example\//);
        expect(updated.logoUrl).toBe(updated.photoUrl);
        expect(updated.selfiePublicObjectKey).toMatch(
          new RegExp(`^profiles/washers/${String(profile._id)}/`),
        );

        const user = await readUser('washer-1');
        expect(user.photoUrl).toBe(updated.photoUrl);
        expect(user.selfieStatus).toBe('ACTIVE');

        // Approval is NOT what made the photo appear.
        expect(updated.verificationStatus).not.toBe('APPROVED');
        expect(usersMock.invalidateUserCache).toHaveBeenCalledWith('washer-1');
      });

      it('[HP] a retake deletes the object it replaced', async () => {
        const profile = await createWasherProfile('washer-1');
        await submitWasherDoc(washerUser, KycDocumentType.SELFIE);
        const first = await readWasher(profile._id);

        storageMock.delete.mockClear();
        await submitWasherDoc(washerUser, KycDocumentType.SELFIE);

        const second = await readWasher(profile._id);
        expect(second.selfiePublicObjectKey).not.toBe(
          first.selfiePublicObjectKey,
        );
        // Leaving the old face readable at a permanent public URL is the bug
        // this guards.
        expect(storageMock.delete).toHaveBeenCalledWith(
          first.selfiePublicObjectKey,
        );
      });

      it('[EDGE] a failed publish does not fail the submission', async () => {
        const profile = await createWasherProfile('washer-1');
        storageMock.upload.mockRejectedValueOnce(new Error('bucket down'));

        // The document is what she came to submit; it must still land.
        const doc = await submitWasherDoc(washerUser, KycDocumentType.SELFIE);
        expect(doc.storageObjectKey).toContain('/selfie/');

        const updated = await readWasher(profile._id);
        expect(updated.photoUrl ?? null).toBeNull();
      });

      it('[EDGE] does not publish HEIC, which no browser renders', async () => {
        const profile = await createWasherProfile('washer-1');
        await service.submitDocument(washerUser, {
          providerType: KycProviderType.WASHER,
          documentType: KycDocumentType.SELFIE,
          base64: PNG_BASE64,
          mimeType: 'image/heic',
        });
        const updated = await readWasher(profile._id);
        expect(updated.photoUrl ?? null).toBeNull();
      });

      it('[EDGE] a merchant branch selfie-equivalent never touches logoUrl', async () => {
        // Only washers get this treatment: a laundromat's logo is its signage,
        // uploaded deliberately, not the owner's face.
        const branch = await createBranch('merchant-1');
        await submitBranchDoc(
          merchantUser,
          String(branch._id),
          KycDocumentType.OWNER_VALID_ID,
        );
        const updated = (await mongoConnection
          .model(Branch.name)
          .findById(branch._id)
          .lean()) as unknown as { logoUrl?: string | null };
        expect(updated.logoUrl ?? null).toBeNull();
      });
    });

    it('[SEC] denies submitting for another provider (cross-provider)', async () => {
      const ownProfile = await createWasherProfile('washer-1');
      await createWasherProfile('washer-2');
      // washer-2 tries to submit against washer-1's profile id
      await expect(
        submitWasherDoc(
          otherWasherUser,
          KycDocumentType.VALID_ID,
          String(ownProfile._id),
        ),
      ).rejects.toThrow(ForbiddenException);

      const branch = await createBranch('merchant-1');
      const strangerMerchant = makeUser('merchant-2', 'merchant');
      await expect(
        service.submitDocument(strangerMerchant, {
          providerType: KycProviderType.MERCHANT_BRANCH,
          providerId: String(branch._id),
          documentType: KycDocumentType.BUSINESS_PERMIT,
          base64: PNG_BASE64,
          mimeType: 'image/png',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // government ID type
  // -------------------------------------------------------------------------

  describe('government ID type', () => {
    const submitPassportFront = (user: User) =>
      submitWasherDoc(
        user,
        KycDocumentType.VALID_ID,
        undefined,
        GovernmentIdType.PASSPORT,
      );

    it('[NP] refuses a front-of-ID upload that does not say which ID it is', async () => {
      await createWasherProfile('washer-1');
      await expect(
        service.submitDocument(washerUser, {
          providerType: KycProviderType.WASHER,
          documentType: KycDocumentType.VALID_ID,
          base64: PNG_BASE64,
          mimeType: 'image/png',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('[NP] refuses a merchant OWNER_VALID_ID without one either', async () => {
      const branch = await createBranch('merchant-1');
      await expect(
        service.submitDocument(merchantUser, {
          providerType: KycProviderType.MERCHANT_BRANCH,
          providerId: String(branch._id),
          documentType: KycDocumentType.OWNER_VALID_ID,
          base64: PNG_BASE64,
          mimeType: 'image/png',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('[HP] records it on the front of the ID', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitPassportFront(washerUser);
      expect(doc.governmentIdType).toBe(GovernmentIdType.PASSPORT);
    });

    it('[NP] drops it from a type that is not a government ID', async () => {
      await createWasherProfile('washer-1');
      const doc = await service.submitDocument(washerUser, {
        providerType: KycProviderType.WASHER,
        documentType: KycDocumentType.SELFIE,
        base64: PNG_BASE64,
        mimeType: 'image/png',
        governmentIdType: GovernmentIdType.PASSPORT,
      });
      expect(doc.governmentIdType ?? null).toBeNull();
    });

    it('[HP] a passport stops the back of the ID being required', async () => {
      await createWasherProfile('washer-1');
      await submitPassportFront(washerUser);

      const status = await service.myKycStatus(
        washerUser,
        KycProviderType.WASHER,
      );
      expect(status.governmentIdType).toBe(GovernmentIdType.PASSPORT);
      const byType = new Map(status.documents.map((d) => [d.documentType, d]));
      expect(byType.get(KycDocumentType.VALID_ID_BACK)?.required).toBe(false);
      // Everything else is untouched — only the back side is conditional.
      expect(byType.get(KycDocumentType.SELFIE)?.required).toBe(true);
    });

    it('[HP] a two-sided ID still requires the back', async () => {
      await createWasherProfile('washer-1');
      await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      const status = await service.myKycStatus(
        washerUser,
        KycProviderType.WASHER,
      );
      expect(status.governmentIdType).toBe(GovernmentIdType.DRIVERS_LICENSE);
      const byType = new Map(status.documents.map((d) => [d.documentType, d]));
      expect(byType.get(KycDocumentType.VALID_ID_BACK)?.required).toBe(true);
    });

    it('[NP] before anything is submitted, both sides are required', async () => {
      await createWasherProfile('washer-1');
      const status = await service.myKycStatus(
        washerUser,
        KycProviderType.WASHER,
      );
      expect(status.governmentIdType ?? null).toBeNull();
      const byType = new Map(status.documents.map((d) => [d.documentType, d]));
      expect(byType.get(KycDocumentType.VALID_ID_BACK)?.required).toBe(true);
    });

    it('[HP] a passport washer reaches APPROVED without ever uploading a back', async () => {
      const profile = await createWasherProfile('washer-1');
      const front = await submitPassportFront(washerUser);
      const rest = requiredKycDocumentTypes(
        KycProviderType.WASHER,
        GovernmentIdType.PASSPORT,
      ).filter((type) => type !== KycDocumentType.VALID_ID);
      expect(rest).not.toContain(KycDocumentType.VALID_ID_BACK);

      const ids = [String(front._id)];
      for (const type of rest) {
        ids.push(String((await submitWasherDoc(washerUser, type))._id));
      }
      for (const id of ids) await service.approveDocument(adminUser, id);

      const fresh = await mongoConnection
        .model(WasherProfile.name)
        .findById(profile._id);
      expect(fresh.verificationStatus).toBe('APPROVED');
    });

    it('[HP] switching to a passport later drops the back requirement', async () => {
      const profile = await createWasherProfile('washer-1');
      // Starts as a two-sided ID, both sides in hand.
      await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await submitWasherDoc(washerUser, KycDocumentType.VALID_ID_BACK);
      // Then the washer realises it should have been the passport all along.
      // The resubmission supersedes the old front, so the claim it carried
      // must not outlive it.
      await submitPassportFront(washerUser);

      const status = await service.myKycStatus(
        washerUser,
        KycProviderType.WASHER,
      );
      expect(status.governmentIdType).toBe(GovernmentIdType.PASSPORT);
      const byType = new Map(status.documents.map((d) => [d.documentType, d]));
      expect(byType.get(KycDocumentType.VALID_ID_BACK)?.required).toBe(false);

      // The now-optional back is still on file, and the reviewer's view agrees
      // with the washer's about what is required.
      const detail = await service.providerDetail(
        KycProviderType.WASHER,
        String(profile._id),
      );
      const back = detail.documents.find(
        (d) => d.document.documentType === KycDocumentType.VALID_ID_BACK,
      );
      expect(back?.required).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // myKycStatus
  // -------------------------------------------------------------------------

  describe('myKycStatus', () => {
    it('[HP] returns one row per allowed document type, null before submission', async () => {
      await createWasherProfile('washer-1');
      await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      const status = await service.myKycStatus(
        washerUser,
        KycProviderType.WASHER,
      );
      expect(status.verificationStatus).toBe('PENDING');
      expect(status.verifiedAt).toBeNull();
      expect(status.providerRejectionReason).toBeNull();
      expect(status.documents).toHaveLength(
        REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER].length,
      );
      const byType = new Map(status.documents.map((d) => [d.documentType, d]));
      expect(byType.get(KycDocumentType.VALID_ID)?.status).toBe(
        KycDocumentStatus.SUBMITTED,
      );
      expect(byType.get(KycDocumentType.SELFIE)?.status).toBeNull();
      expect(byType.get(KycDocumentType.VALID_ID)?.required).toBe(true);
      expect(byType.get(KycDocumentType.BARANGAY_CLEARANCE)?.expiryPolicy).toBe(
        KycExpiryPolicy.REQUIRED,
      );
      expect(byType.get(KycDocumentType.SELFIE)?.expiryPolicy).toBe(
        KycExpiryPolicy.NONE,
      );
    });

    it('[HP] still lists a retired document type the merchant already uploaded, flagged not-required', async () => {
      const branch = await createBranch('merchant-1');
      await submitBranchDoc(
        merchantUser,
        String(branch._id),
        KycDocumentType.BUSINESS_PERMIT,
      );

      const status = await service.myKycStatus(
        merchantUser,
        KycProviderType.MERCHANT_BRANCH,
        String(branch._id),
      );
      const permit = status.documents.find(
        (d) => d.documentType === KycDocumentType.BUSINESS_PERMIT,
      );
      expect(permit?.required).toBe(false);
      expect(permit?.status).toBe(KycDocumentStatus.SUBMITTED);
      expect(
        status.documents.filter((d) => d.required).map((d) => d.documentType),
      ).toEqual(REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.MERCHANT_BRANCH]);
    });
  });

  // -------------------------------------------------------------------------
  // expiry
  // -------------------------------------------------------------------------

  describe('document expiry', () => {
    it('[NP] refuses a REQUIRED-expiry document submitted without a date', async () => {
      await createWasherProfile('washer-1');
      await expect(
        service.submitDocument(washerUser, {
          providerType: KycProviderType.WASHER,
          documentType: KycDocumentType.BARANGAY_CLEARANCE,
          base64: PNG_BASE64,
          mimeType: 'image/png',
        }),
      ).rejects.toThrow('An expiry date is required for this document.');
    });

    it('[NP] refuses a document that has already expired', async () => {
      await createWasherProfile('washer-1');
      await expect(
        service.submitDocument(washerUser, {
          providerType: KycProviderType.WASHER,
          documentType: KycDocumentType.BARANGAY_CLEARANCE,
          base64: PNG_BASE64,
          mimeType: 'image/png',
          expiresAt: daysFromNow(-1),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('[HP] ignores an expiry date on a type that never expires', async () => {
      await createWasherProfile('washer-1');
      const doc = await service.submitDocument(washerUser, {
        providerType: KycProviderType.WASHER,
        documentType: KycDocumentType.SELFIE,
        base64: PNG_BASE64,
        mimeType: 'image/png',
        expiresAt: daysFromNow(30),
      });
      expect(doc.expiresAt).toBeNull();
    });

    it('[NP] an expired approval does not satisfy its requirement, so the badge is never granted', async () => {
      const profile = await createWasherProfile('washer-1');
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];
      const last = required[required.length - 1];

      const ids = new Map<KycDocumentType, string>();
      for (const type of required) {
        const d = await submitWasherDoc(washerUser, type);
        ids.set(type, String(d._id));
      }
      for (const type of required) {
        if (type !== last) {
          await service.approveDocument(adminUser, ids.get(type)!);
        }
      }

      // The clearance lapses the way real time would — submit-time validation
      // can't produce this, only the passage of time can.
      await mongoConnection
        .model(KycDocument.name)
        .updateOne(
          { _id: ids.get(KycDocumentType.BARANGAY_CLEARANCE) },
          { $set: { expiresAt: daysFromNow(-1) } },
        );

      await service.approveDocument(adminUser, ids.get(last)!);

      const fresh = await mongoConnection
        .model(WasherProfile.name)
        .findById(profile._id);
      // IN_REVIEW, not PENDING: every required document IS submitted, so the
      // washer has nothing left to do. The badge is still withheld, which is
      // what this test is about.
      expect(fresh.verificationStatus).toBe('IN_REVIEW');
      expect(fresh.verifiedAt).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // approve / reject / resubmit lifecycle
  // -------------------------------------------------------------------------

  describe('review lifecycle', () => {
    it('[HP] flips the washer profile to APPROVED only after ALL required types are approved', async () => {
      const profile = await createWasherProfile('washer-1');
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];
      const ids: string[] = [];
      for (const type of required) {
        const d = await submitWasherDoc(washerUser, type);
        ids.push(String(d._id));
      }

      // Approve everything but the last — the badge must not be granted yet.
      for (const id of ids.slice(0, -1)) {
        await service.approveDocument(adminUser, id);
      }

      let fresh = await mongoConnection
        .model(WasherProfile.name)
        .findById(profile._id);
      // IN_REVIEW rather than PENDING: all five documents are in, one is still
      // waiting on a reviewer. The washer is owed an answer, not more work.
      expect(fresh.verificationStatus).toBe('IN_REVIEW');

      const approved = await service.approveDocument(
        adminUser,
        ids[ids.length - 1],
      );
      expect(approved.status).toBe(KycDocumentStatus.APPROVED);
      expect(approved.reviewedByUid).toBe('admin-1');

      fresh = await mongoConnection
        .model(WasherProfile.name)
        .findById(profile._id);
      expect(fresh.verificationStatus).toBe('APPROVED');
      expect(fresh.verifiedBy).toBe('admin-1');
      expect(fresh.verifiedAt).toBeTruthy();

      const audit = await mongoConnection
        .collection('kyc_audit_events')
        .find({ event: KycAuditEventType.PROVIDER_VERIFICATION_APPROVED })
        .toArray();
      expect(audit).toHaveLength(1);
    });

    it('[HP] flips a merchant branch to APPROVED after every required document approves', async () => {
      const branch = await createBranch('merchant-1');
      const required =
        REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.MERCHANT_BRANCH];
      for (const type of required) {
        const d = await submitBranchDoc(merchantUser, String(branch._id), type);
        await service.approveDocument(supportUser, String(d._id));
      }

      const fresh = await mongoConnection
        .model(Branch.name)
        .findById(branch._id);
      expect(fresh.verificationStatus).toBe('APPROVED');
    });

    it('[NP] a legacy BUSINESS_PERMIT alone no longer verifies a branch', async () => {
      const branch = await createBranch('merchant-1');
      const permit = await submitBranchDoc(
        merchantUser,
        String(branch._id),
        KycDocumentType.BUSINESS_PERMIT,
      );
      const ownerId = await submitBranchDoc(
        merchantUser,
        String(branch._id),
        KycDocumentType.OWNER_VALID_ID,
      );
      await service.approveDocument(supportUser, String(permit._id));
      await service.approveDocument(supportUser, String(ownerId._id));

      const fresh = await mongoConnection
        .model(Branch.name)
        .findById(branch._id);
      expect(fresh.verificationStatus).toBe('PENDING');
    });

    it('[SEC] denies self-approval even for a reviewer-role account that owns the provider', async () => {
      await createWasherProfile('admin-1'); // provider owned by the "admin"
      const selfOwner = makeUser('admin-1', 'washer');
      const doc = await submitWasherDoc(selfOwner, KycDocumentType.VALID_ID);

      const ownerAsReviewer = makeUser('admin-1', 'admin');
      await expect(
        service.approveDocument(ownerAsReviewer, String(doc._id)),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.rejectDocument(
          ownerAsReviewer,
          String(doc._id),
          KycRejectionReason.BLURRY,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[HP] rejection requires a reason, marks the provider REJECTED, and resubmission supersedes + resets to PENDING', async () => {
      const profile = await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      // OTHER without a note leaves the provider told to fix "something".
      await expect(
        service.rejectDocument(
          adminUser,
          String(doc._id),
          KycRejectionReason.OTHER,
          '  ',
        ),
      ).rejects.toThrow(BadRequestException);

      const rejected = await service.rejectDocument(
        adminUser,
        String(doc._id),
        KycRejectionReason.BLURRY,
      );
      expect(rejected.status).toBe(KycDocumentStatus.REJECTED);
      expect(rejected.rejectionReasonCode).toBe(KycRejectionReason.BLURRY);
      expect(rejected.rejectionReason).toBe(
        KYC_REJECTION_REASON_TEXT[KycRejectionReason.BLURRY],
      );

      let fresh = await mongoConnection
        .model(WasherProfile.name)
        .findById(profile._id);
      expect(fresh.verificationStatus).toBe('REJECTED');
      expect(fresh.rejectionReason).toBe(
        KYC_REJECTION_REASON_TEXT[KycRejectionReason.BLURRY],
      );

      // Resubmit the same type
      const resubmitted = await submitWasherDoc(
        washerUser,
        KycDocumentType.VALID_ID,
      );
      expect(resubmitted.supersedesDocumentId).toBe(String(doc._id));

      const old = await mongoConnection
        .model(KycDocument.name)
        .findById(doc._id);
      expect(old.status).toBe(KycDocumentStatus.SUPERSEDED);

      fresh = await mongoConnection
        .model(WasherProfile.name)
        .findById(profile._id);
      expect(fresh.verificationStatus).toBe('PENDING');
      expect(fresh.rejectionReason).toBeNull();

      // The rejected+superseded doc can no longer be reviewed
      await expect(
        service.approveDocument(adminUser, String(doc._id)),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // review queue
  // -------------------------------------------------------------------------

  describe('reviewQueue', () => {
    const queueIds = (q: { data: { document: KycDocument }[] }) =>
      q.data.map((r) => String(r.document._id));

    it('[HP] lists pending documents oldest-first and excludes reviewed/superseded ones', async () => {
      await createWasherProfile('washer-1');
      const d1 = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      const d2 = await submitWasherDoc(washerUser, KycDocumentType.SELFIE);
      await service.approveDocument(adminUser, String(d2._id));

      const queue = await service.reviewQueue();
      expect(queueIds(queue)).toEqual([String(d1._id)]);
      expect(queue.total).toBe(1);
    });

    it('[HP] filters the queue by claimed / unclaimed', async () => {
      await createWasherProfile('washer-1');
      const d1 = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      const d2 = await submitWasherDoc(washerUser, KycDocumentType.SELFIE);
      await service.claimDocumentForReview(adminUser, String(d1._id));

      expect(queueIds(await service.reviewQueue(true))).toEqual([
        String(d1._id),
      ]);
      expect(queueIds(await service.reviewQueue(false))).toEqual([
        String(d2._id),
      ]);
      expect((await service.reviewQueue()).data).toHaveLength(2);
    });

    it('[HP] resolves the provider name and owner email a reviewer needs', async () => {
      const branch = await createBranch('merchant-1');
      await mongoConnection.model(User.name).create({
        _id: 'merchant-1',
        email: 'owner@shop.ph',
        firstName: 'Ana',
        lastName: 'Cruz',
        phoneNumber: '09171234567',
        role: new Types.ObjectId(),
      });
      await submitBranchDoc(
        merchantUser,
        String(branch._id),
        KycDocumentType.DTI_CERTIFICATE,
      );

      const [row] = (await service.reviewQueue()).data;
      expect(row.providerName).toBe('Main Branch');
      expect(row.ownerEmail).toBe('owner@shop.ph');
    });

    it('[HP] resolves the claiming reviewer email so an override is an informed one', async () => {
      await createWasherProfile('washer-1');
      await mongoConnection.model(User.name).create({
        _id: 'admin-1',
        email: 'reviewer@lalaba.ph',
        firstName: 'Rey',
        lastName: 'Santos',
        phoneNumber: '09171234568',
        role: new Types.ObjectId(),
      });
      const unclaimed = await submitWasherDoc(
        washerUser,
        KycDocumentType.VALID_ID,
      );
      const claimed = await submitWasherDoc(washerUser, KycDocumentType.SELFIE);
      await service.claimDocumentForReview(adminUser, String(claimed._id));

      const rows = (await service.reviewQueue()).data;
      const claimedRow = rows.find(
        (r) => String(r.document._id) === String(claimed._id),
      );
      const unclaimedRow = rows.find(
        (r) => String(r.document._id) === String(unclaimed._id),
      );
      expect(claimedRow?.claimedByEmail).toBe('reviewer@lalaba.ph');
      // Unclaimed rows carry no reviewer — not a stale one from a sibling row.
      expect(unclaimedRow?.claimedByEmail).toBeNull();
    });

    it('[HP] paginates, clamping the page size', async () => {
      await createWasherProfile('washer-1');
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];
      for (const type of required) await submitWasherDoc(washerUser, type);

      const page1 = await service.reviewQueue(null, 2, 0);
      expect(page1.data).toHaveLength(2);
      expect(page1.total).toBe(required.length);
      expect(page1.limit).toBe(2);

      const page2 = await service.reviewQueue(null, 2, 2);
      expect(queueIds(page2)).not.toEqual(queueIds(page1));

      // Over-large and non-positive page sizes are clamped, never honored.
      expect((await service.reviewQueue(null, 5000, 0)).limit).toBe(100);
      expect((await service.reviewQueue(null, 0, -5)).offset).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // review claim (UNDER_REVIEW)
  // -------------------------------------------------------------------------

  describe('claimDocumentForReview', () => {
    it('[HP] moves SUBMITTED → UNDER_REVIEW, records the reviewer, and audits it', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      const claimed = await service.claimDocumentForReview(
        adminUser,
        String(doc._id),
      );
      expect(claimed.status).toBe(KycDocumentStatus.UNDER_REVIEW);
      expect(claimed.claimedByUid).toBe('admin-1');
      expect(claimed.claimedAt).toBeInstanceOf(Date);

      const audits = await mongoConnection
        .collection('kyc_audit_events')
        .find({ event: KycAuditEventType.DOCUMENT_CLAIMED_FOR_REVIEW })
        .toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].actorUid).toBe('admin-1');
    });

    it('[HP] re-claiming by the same reviewer is idempotent (no second audit event)', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      const first = await service.claimDocumentForReview(
        adminUser,
        String(doc._id),
      );
      const second = await service.claimDocumentForReview(
        adminUser,
        String(doc._id),
      );
      expect(second.status).toBe(KycDocumentStatus.UNDER_REVIEW);
      expect(second.claimedAt!.getTime()).toBe(first.claimedAt!.getTime());

      const audits = await mongoConnection
        .collection('kyc_audit_events')
        .find({ event: KycAuditEventType.DOCUMENT_CLAIMED_FOR_REVIEW })
        .toArray();
      expect(audits).toHaveLength(1);
    });

    it('[SEC] refuses a takeover by a second reviewer', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await service.claimDocumentForReview(adminUser, String(doc._id));

      await expect(
        service.claimDocumentForReview(supportUser, String(doc._id)),
      ).rejects.toThrow(ForbiddenException);

      const persisted = await mongoConnection
        .model(KycDocument.name)
        .findById(String(doc._id));
      expect(persisted.claimedByUid).toBe('admin-1');
    });

    it('[SEC] a provider can never claim their own document for review', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await expect(
        service.claimDocumentForReview(washerUser, String(doc._id)),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[NP] a decided document can no longer be claimed', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await service.approveDocument(adminUser, String(doc._id));

      await expect(
        service.claimDocumentForReview(supportUser, String(doc._id)),
      ).rejects.toThrow(BadRequestException);
    });

    it('[HP] approve works from SUBMITTED and from UNDER_REVIEW, clearing the claim', async () => {
      await createWasherProfile('washer-1');
      const fromSubmitted = await submitWasherDoc(
        washerUser,
        KycDocumentType.VALID_ID,
      );
      const approvedA = await service.approveDocument(
        adminUser,
        String(fromSubmitted._id),
      );
      expect(approvedA.status).toBe(KycDocumentStatus.APPROVED);

      const fromUnderReview = await submitWasherDoc(
        washerUser,
        KycDocumentType.SELFIE,
      );
      await service.claimDocumentForReview(
        adminUser,
        String(fromUnderReview._id),
      );
      const approvedB = await service.approveDocument(
        adminUser,
        String(fromUnderReview._id),
      );
      expect(approvedB.status).toBe(KycDocumentStatus.APPROVED);
      expect(approvedB.claimedByUid).toBeNull();
      expect(approvedB.claimedAt).toBeNull();
    });

    it('[HP] reject works from UNDER_REVIEW too', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await service.claimDocumentForReview(adminUser, String(doc._id));

      const rejected = await service.rejectDocument(
        adminUser,
        String(doc._id),
        KycRejectionReason.BLURRY,
      );
      expect(rejected.status).toBe(KycDocumentStatus.REJECTED);
      expect(rejected.claimedByUid).toBeNull();
    });

    it('[HP] a different reviewer may still decide a claimed document — the override is audited', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await service.claimDocumentForReview(adminUser, String(doc._id));

      const approved = await service.approveDocument(
        supportUser,
        String(doc._id),
      );
      expect(approved.status).toBe(KycDocumentStatus.APPROVED);
      expect(approved.reviewedByUid).toBe('support-1');

      const audits = await mongoConnection
        .collection('kyc_audit_events')
        .find({ event: KycAuditEventType.DOCUMENT_CLAIM_OVERRIDDEN })
        .toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].actorUid).toBe('support-1');
      expect(audits[0].details.claimedByUid).toBe('admin-1');
    });
  });

  // -------------------------------------------------------------------------
  // signed URL access
  // -------------------------------------------------------------------------

  describe('getDocumentUrl', () => {
    it('[HP] issues a signed URL to the owner and to admin/support, and audits each issuance', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      const ownerUrl = await service.getDocumentUrl(
        washerUser,
        String(doc._id),
      );
      const adminUrl = await service.getDocumentUrl(adminUser, String(doc._id));
      const supportUrl = await service.getDocumentUrl(
        supportUser,
        String(doc._id),
      );
      expect(ownerUrl).toContain('https://signed.example/kyc/washer/');
      expect(adminUrl).toBe(ownerUrl);
      expect(supportUrl).toBe(ownerUrl);
      expect(storageMock.getSignedReadUrl).toHaveBeenCalledWith(
        doc.storageObjectKey,
        300,
      );

      const audits = await mongoConnection
        .collection('kyc_audit_events')
        .find({ event: KycAuditEventType.DOCUMENT_URL_ISSUED })
        .toArray();
      expect(audits).toHaveLength(3);
      expect(audits.map((a) => a.actorUid).sort()).toEqual([
        'admin-1',
        'support-1',
        'washer-1',
      ]);
    });

    it('[SEC] denies signed-URL access to any non-owning, non-reviewer user', async () => {
      await createWasherProfile('washer-1');
      await createWasherProfile('washer-2');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      await expect(
        service.getDocumentUrl(otherWasherUser, String(doc._id)),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.getDocumentUrl(makeUser('cust-1', 'customer'), String(doc._id)),
      ).rejects.toThrow(ForbiddenException);
      expect(storageMock.getSignedReadUrl).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Provider-level IN_REVIEW
  // -------------------------------------------------------------------------

  describe('provider verification status', () => {
    const washerStatus = async (profileId: unknown) =>
      (await mongoConnection.model(WasherProfile.name).findById(profileId))
        ?.verificationStatus;

    it('[HP] walks PENDING → IN_REVIEW as the last required document lands', async () => {
      const profile = await createWasherProfile('washer-1');
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];

      for (const type of required.slice(0, -1)) {
        await submitWasherDoc(washerUser, type);
        // Still owed at least one document, so the partner still has work.
        expect(await washerStatus(profile._id)).toBe('PENDING');
      }

      await submitWasherDoc(washerUser, required[required.length - 1]);
      expect(await washerStatus(profile._id)).toBe('IN_REVIEW');
    });

    it('[HP] a rejection drops IN_REVIEW to REJECTED, and resubmitting restores it', async () => {
      const profile = await createWasherProfile('washer-1');
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];
      const ids: string[] = [];
      for (const type of required) {
        ids.push(String((await submitWasherDoc(washerUser, type))._id));
      }
      expect(await washerStatus(profile._id)).toBe('IN_REVIEW');

      await service.rejectDocument(
        adminUser,
        ids[0],
        KycRejectionReason.BLURRY,
      );
      expect(await washerStatus(profile._id)).toBe('REJECTED');

      // The replacement supersedes the rejected one, so nothing required is
      // REJECTED any more and the full set is back in a reviewer's hands.
      await submitWasherDoc(washerUser, required[0]);
      expect(await washerStatus(profile._id)).toBe('IN_REVIEW');
    });

    it('[NP] an expired approval keeps the provider IN_REVIEW, never APPROVED', async () => {
      const profile = await createWasherProfile('washer-1');
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];
      const ids = new Map<KycDocumentType, string>();
      for (const type of required) {
        ids.set(type, String((await submitWasherDoc(washerUser, type))._id));
      }
      for (const type of required) {
        await service.approveDocument(adminUser, ids.get(type)!);
      }
      expect(await washerStatus(profile._id)).toBe('APPROVED');

      // Time passes and the clearance lapses. Nothing downgrades a granted
      // badge — but a recompute triggered by new activity must not re-grant it
      // either, so the status settles at IN_REVIEW.
      await mongoConnection
        .model(KycDocument.name)
        .updateOne(
          { _id: ids.get(KycDocumentType.BARANGAY_CLEARANCE) },
          { $set: { expiresAt: daysFromNow(-1) } },
        );
      await submitWasherDoc(washerUser, KycDocumentType.SELFIE);
      expect(await washerStatus(profile._id)).toBe('IN_REVIEW');
    });
  });

  // -------------------------------------------------------------------------
  // Decision notifications
  // -------------------------------------------------------------------------

  describe('decision notifications', () => {
    it('[HP] pushes the reviewer’s reason to the owner on every rejection', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      await service.rejectDocument(
        adminUser,
        String(doc._id),
        KycRejectionReason.BLURRY,
      );

      // Decisions go through notify(), not sendToUser(): the outcome has to
      // land in the durable in-app feed as well as the push.
      expect(notificationsMock.notify).toHaveBeenCalledTimes(1);
      const [target, payload] = notificationsMock.notify.mock.calls[0] as [
        { uid: string },
        { body: string; data: Record<string, string> },
      ];
      expect(target.uid).toBe('washer-1');
      // The partner must be able to act from the notification alone.
      expect(payload.body).toContain(
        KYC_REJECTION_REASON_TEXT[KycRejectionReason.BLURRY],
      );
      expect(payload.data.type).toBe('KYC_REJECTED');
      expect(payload.data.documentType).toBe(KycDocumentType.VALID_ID);
    });

    it('[NP] announces verification once, on the transition — not per approved document', async () => {
      await createWasherProfile('washer-1');
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];
      const ids: string[] = [];
      for (const type of required) {
        ids.push(String((await submitWasherDoc(washerUser, type))._id));
      }
      for (const id of ids) {
        await service.approveDocument(adminUser, id);
      }

      const approvals = notificationsMock.notify.mock.calls.filter(
        (c) =>
          (c[1] as { data: Record<string, string> }).data.type ===
          'KYC_APPROVED',
      );
      expect(approvals).toHaveLength(1);
    });

    it('[NP] a failed push never fails the decision', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      notificationsMock.notify.mockRejectedValueOnce(new Error('FCM down'));

      const rejected = await service.rejectDocument(
        adminUser,
        String(doc._id),
        KycRejectionReason.BLURRY,
      );
      expect(rejected.status).toBe(KycDocumentStatus.REJECTED);
    });
  });

  // -------------------------------------------------------------------------
  // Admin monitoring
  // -------------------------------------------------------------------------

  describe('monitoring', () => {
    it('[HP] summarises each provider against its required set, including untouched ones', async () => {
      const profile = await createWasherProfile('washer-1');
      await createWasherProfile('washer-2'); // never submitted anything
      const required = REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER];

      const first = await submitWasherDoc(washerUser, required[0]);
      await submitWasherDoc(washerUser, required[1]);
      await service.approveDocument(adminUser, String(first._id));

      const page = await service.providerSummaries({ limit: 25, offset: 0 });
      expect(page.total).toBe(2);

      const active = page.data.find(
        (p) => p.providerId === String(profile._id),
      )!;
      expect(active.requiredCount).toBe(required.length);
      expect(active.approvedCount).toBe(1);
      expect(active.pendingCount).toBe(1);
      expect(active.rejectedCount).toBe(0);

      // A provider that never started still appears — otherwise an admin can't
      // see who has stalled before uploading anything.
      const untouched = page.data.find((p) => p.ownerUid === 'washer-2')!;
      expect(untouched.approvedCount).toBe(0);
      expect(untouched.verificationStatus).toBe('PENDING');
    });

    // Regression: every washer registration also creates a Branch row as an FK
    // shim (UsersService.createWasherShopAnchor). It used to be counted as a
    // laundromat, so one signup produced TWO verification cards — the correct
    // "Home washer" one plus a phantom "Laundromat" no reviewer could clear.
    it('[REG] a washer produces exactly one provider card, not two', async () => {
      const anchor = await createBranch('washer-1');
      await mongoConnection.model(WasherProfile.name).create({
        uid: 'washer-1',
        displayName: 'Washer washer-1',
        branchId: String(anchor._id),
      });

      const page = await service.providerSummaries({ limit: 25, offset: 0 });

      expect(page.total).toBe(1);
      expect(page.data).toHaveLength(1);
      expect(page.data[0].providerType).toBe(KycProviderType.WASHER);
      expect(
        page.data.some(
          (p) => p.providerType === KycProviderType.MERCHANT_BRANCH,
        ),
      ).toBe(false);
    });

    it('[REG] a real laundromat is still listed alongside washers', async () => {
      // The exclusion must be surgical: it drops anchors, not branches.
      const anchor = await createBranch('washer-1');
      await mongoConnection.model(WasherProfile.name).create({
        uid: 'washer-1',
        displayName: 'Washer washer-1',
        branchId: String(anchor._id),
      });
      await createBranch('merchant-1');

      const page = await service.providerSummaries({ limit: 25, offset: 0 });
      expect(page.total).toBe(2);
      expect(
        page.data.filter((p) => p.providerType === KycProviderType.WASHER),
      ).toHaveLength(1);
      expect(
        page.data.filter(
          (p) => p.providerType === KycProviderType.MERCHANT_BRANCH,
        ),
      ).toHaveLength(1);
    });

    it('[REG] metrics do not count anchor branches as pending laundromats', async () => {
      const anchor = await createBranch('washer-1');
      await mongoConnection.model(WasherProfile.name).create({
        uid: 'washer-1',
        displayName: 'Washer washer-1',
        branchId: String(anchor._id),
      });

      const metrics = await service.metrics();
      // One provider pending — the washer. Not two.
      expect(metrics.providersPending).toBe(1);
    });

    it('[EDGE] a non-ObjectId branchId does not break the provider list', async () => {
      // branchId is a plain string while Branch._id is an ObjectId. Passing an
      // uncastable value into $nin throws a CastError for the WHOLE query, so
      // one malformed row would take down the entire admin verifications page.
      await createWasherProfile('washer-1'); // branchId: "anchor-washer-1"
      await createBranch('merchant-1');

      const page = await service.providerSummaries({ limit: 25, offset: 0 });
      expect(page.total).toBe(2);
    });

    it('[HP] provider detail keeps superseded history and lists what is missing', async () => {
      const profile = await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await service.rejectDocument(
        adminUser,
        String(doc._id),
        KycRejectionReason.BLURRY,
      );
      await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);

      const detail = await service.providerDetail(
        KycProviderType.WASHER,
        String(profile._id),
      );

      // Both the replacement and the rejected original — an auditor needs to
      // see what the decision was made against.
      expect(detail.documents).toHaveLength(2);
      expect(
        detail.documents.some(
          (d) => d.document.status === KycDocumentStatus.SUPERSEDED,
        ),
      ).toBe(true);
      expect(detail.missingDocumentTypes).not.toContain(
        KycDocumentType.VALID_ID,
      );
      expect(detail.missingDocumentTypes).toContain(KycDocumentType.SELFIE);
      expect(detail.auditTrail.length).toBeGreaterThan(0);
    });

    it('[HP] the audit log reads back the append-only trail, filterable by event', async () => {
      await createWasherProfile('washer-1');
      const doc = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await service.rejectDocument(
        adminUser,
        String(doc._id),
        KycRejectionReason.BLURRY,
      );

      const all = await service.auditLog({ limit: 50, offset: 0 });
      expect(all.total).toBeGreaterThan(1);

      const rejections = await service.auditLog({
        event: KycAuditEventType.DOCUMENT_REJECTED,
        limit: 50,
        offset: 0,
      });
      expect(rejections.total).toBe(1);
      expect(rejections.data[0].actorUid).toBe('admin-1');
      // details is serialized for transport, not typed per event.
      expect(JSON.parse(rejections.data[0].details!)).toEqual({
        reason: KYC_REJECTION_REASON_TEXT[KycRejectionReason.BLURRY],
        reasonCode: KycRejectionReason.BLURRY,
        note: null,
      });
    });

    it('[HP] metrics count the queue and report null turnaround when nothing was decided', async () => {
      await createWasherProfile('washer-1');
      await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      await submitWasherDoc(washerUser, KycDocumentType.SELFIE);

      const metrics = await service.metrics();
      expect(metrics.pendingReview).toBe(2);
      expect(metrics.claimedForReview).toBe(0);
      expect(metrics.providersPending).toBe(1);
      expect(metrics.oldestPendingSubmittedAt).toBeTruthy();
      // Null, not 0 — "no decisions" and "instant decisions" must not look the
      // same on the dashboard.
      expect(metrics.avgHoursToDecision).toBeNull();
      expect(metrics.rejectionRate).toBeNull();
    });

    it('[HP] metrics report turnaround and rejection rate once decisions exist', async () => {
      await createWasherProfile('washer-1');
      const a = await submitWasherDoc(washerUser, KycDocumentType.VALID_ID);
      const b = await submitWasherDoc(washerUser, KycDocumentType.SELFIE);
      await service.approveDocument(adminUser, String(a._id));
      await service.rejectDocument(
        adminUser,
        String(b._id),
        KycRejectionReason.BLURRY,
      );

      const metrics = await service.metrics();
      expect(metrics.approvedInPeriod).toBe(1);
      expect(metrics.rejectedInPeriod).toBe(1);
      expect(metrics.rejectionRate).toBe(0.5);
      expect(metrics.avgHoursToDecision).not.toBeNull();
      expect(metrics.pendingReview).toBe(0);
    });
  });
});
