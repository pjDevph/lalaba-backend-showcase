// Jest mock assertions like expect(mock.fn) trip @typescript-eslint/unbound-method
// on plain mocked-interface references — safe here, so disabled for this spec.
/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CourierVerificationService } from './courier-verification.service';
import {
  CourierSelfie,
  CourierSelfieDocument,
  CourierSelfieSchema,
  CourierSelfieStatus,
  LivenessChallenge,
} from './schemas/courier-selfie.schema';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { getModelToken } from '@nestjs/mongoose';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeUser = (uid: string): User => ({ _id: uid }) as unknown as User;

// A real JPEG magic-byte prefix (FF D8 FF) — assertContentMatchesMimeType
// sniffs the actual bytes, so a placeholder string would be rejected.
const jpegBase64 = (payload = 'courier-selfie-bytes') =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from(payload),
  ]).toString('base64');

const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString('base64');

const submitInput = (overrides: Record<string, unknown> = {}) => ({
  base64: jpegBase64(),
  mimeType: 'image/jpeg',
  livenessChallenge: LivenessChallenge.BLINK,
  livenessMetadata: {
    durationMs: 1800,
    eyesOpenScore: 0.94,
    yawDegrees: 2.1,
    pitchDegrees: -1.4,
    attemptCount: 1,
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CourierVerificationService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: CourierVerificationService;
  let module: TestingModule;
  let storageMock: jest.Mocked<StorageProvider>;
  let usersServiceMock: { invalidateUserCache: jest.Mock };
  let userModel: Model<UserDocument>;
  let selfieModel: Model<CourierSelfieDocument>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    storageMock = {
      upload: jest.fn(async (_b, key, _ct) => `https://public.example/${key}`),
      uploadPrivate: jest.fn(async (_b, key, _ct) => key),
      getSignedReadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
      delete: jest.fn(async (_key: string): Promise<void> => {}),
    };
    usersServiceMock = { invalidateUserCache: jest.fn(async () => {}) };
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: CourierSelfie.name, schema: CourierSelfieSchema },
          { name: User.name, schema: UserSchema },
        ]),
      ],
      providers: [
        CourierVerificationService,
        { provide: STORAGE_PROVIDER, useValue: storageMock },
        { provide: UsersService, useValue: usersServiceMock },
      ],
    }).compile();

    service = module.get<CourierVerificationService>(
      CourierVerificationService,
    );
    mongoConnection = module.get<Connection>(getConnectionToken());
    userModel = module.get<Model<UserDocument>>(getModelToken(User.name));
    selfieModel = module.get<Model<CourierSelfieDocument>>(
      getModelToken(CourierSelfie.name),
    );
    // The partial unique index on (courierUid, ACTIVE) is what guarantees one
    // live selfie per courier; without building it the invariant is untested.
    await selfieModel.createIndexes();
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

  const seedCourier = async (uid: string) => {
    // `role` is an ObjectId ref on the schema; a plain id string is what the
    // rest of the suite uses too, so the cast keeps the seed readable.
    await userModel.create({
      _id: uid,
      role: '507f1f77bcf86cd799439011',
      email: `${uid}@test.com`,
      firstName: 'Test',
      lastName: 'Courier',
      phoneNumber: '09171234567',
    } as unknown as UserDocument);
    return makeUser(uid);
  };

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  describe('submitSelfie', () => {
    it('[HP] uploads publicly, stores the row, and opens the gate', async () => {
      const courier = await seedCourier('courier-1');

      const selfie = await service.submitSelfie(courier, submitInput());

      expect(selfie.status).toBe(CourierSelfieStatus.ACTIVE);
      expect(selfie.publicUrl).toContain('profiles/couriers/courier-1/');
      expect(selfie.supersedesId).toBeNull();

      // Public upload, never the private evidence path — this photo is meant
      // to be seen, unlike every KYC document.
      expect(storageMock.upload).toHaveBeenCalledTimes(1);
      expect(storageMock.uploadPrivate).not.toHaveBeenCalled();

      // The key is server-derived and namespaced by uid; the client has no say.
      const [, key] = storageMock.upload.mock.calls[0];
      expect(key).toMatch(/^profiles\/couriers\/courier-1\/[\w-]+\.jpg$/);

      const user = await userModel.findById('courier-1').exec();
      expect(user?.photoUrl).toBe(selfie.publicUrl);
      expect(user?.selfieStatus).toBe(CourierSelfieStatus.ACTIVE);
      expect(user?.selfieVerifiedAt).toBeTruthy();

      // Writing selfieStatus is only half the gate: GqlAuthGuard reads a cached
      // copy of this document, so skipping the invalidation leaves the courier
      // 401ing on every order query until the TTL lapses.
      expect(usersServiceMock.invalidateUserCache).toHaveBeenCalledWith(
        'courier-1',
      );
    });

    it('[HP] a retake supersedes the previous row and deletes its object', async () => {
      const courier = await seedCourier('courier-2');
      const first = await service.submitSelfie(courier, submitInput());
      const firstKey = (await selfieModel.findById(String(first._id)).exec())
        ?.storageKey;

      const second = await service.submitSelfie(
        courier,
        submitInput({ base64: jpegBase64('second-take') }),
      );

      expect(second.supersedesId).toBe(String(first._id));
      expect(second.status).toBe(CourierSelfieStatus.ACTIVE);

      const refreshedFirst = await selfieModel
        .findById(String(first._id))
        .exec();
      expect(refreshedFirst?.status).toBe(CourierSelfieStatus.SUPERSEDED);

      // The old face does not linger in a public bucket.
      expect(storageMock.delete).toHaveBeenCalledWith(firstKey);

      const user = await userModel.findById('courier-2').exec();
      expect(user?.photoUrl).toBe(second.publicUrl);
    });

    it('[NP] rejects a non-JPEG image', async () => {
      const courier = await seedCourier('courier-3');
      await expect(
        service.submitSelfie(
          courier,
          submitInput({ base64: PNG_BASE64, mimeType: 'image/png' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it('[SEC] rejects bytes that do not match the declared MIME type', async () => {
      const courier = await seedCourier('courier-4');
      // Claims JPEG, actually PNG bytes — the magic-byte sniff is what catches
      // a client lying about content to smuggle a different format through.
      await expect(
        service.submitSelfie(
          courier,
          submitInput({ base64: PNG_BASE64, mimeType: 'image/jpeg' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it('[NP] rejects an oversized image', async () => {
      const courier = await seedCourier('courier-5');
      const oversized = 'A'.repeat(7 * 1024 * 1024 + 4);
      await expect(
        service.submitSelfie(courier, submitInput({ base64: oversized })),
      ).rejects.toThrow(BadRequestException);
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it('[NP] rejects a payload that is not valid base64', async () => {
      const courier = await seedCourier('courier-6');
      await expect(
        service.submitSelfie(courier, submitInput({ base64: 'not base64!!' })),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  describe('revokeSelfie', () => {
    it('[HP] re-locks the courier and deletes the stored object', async () => {
      const courier = await seedCourier('courier-7');
      const selfie = await service.submitSelfie(courier, submitInput());
      const storedKey = (await selfieModel.findById(String(selfie._id)).exec())
        ?.storageKey;

      const revoked = await service.revokeSelfie(
        String(selfie._id),
        'admin-1',
        'Face not clearly visible',
      );

      expect(revoked.status).toBe(CourierSelfieStatus.REVOKED);
      expect(revoked.revokedByUid).toBe('admin-1');
      expect(revoked.revocationReason).toBe('Face not clearly visible');

      const user = await userModel.findById('courier-7').exec();
      expect(user?.photoUrl).toBeNull();
      expect(user?.selfieStatus).toBe(CourierSelfieStatus.REVOKED);
      expect(user?.selfieRevokedReason).toBe('Face not clearly visible');

      // Nulling the pointer is not erasure — the object itself must go, or the
      // revoked face stays readable at its permanent public URL.
      expect(storageMock.delete).toHaveBeenCalledWith(storedKey);

      // A revocation that only lands in Mongo is not in force: the guard would
      // keep clearing this courier off the cached document for the rest of the
      // TTL, which is the wrong direction to be stale in.
      expect(usersServiceMock.invalidateUserCache).toHaveBeenCalledWith(
        'courier-7',
      );
    });

    it('[NP] requires a reason', async () => {
      const courier = await seedCourier('courier-8');
      const selfie = await service.submitSelfie(courier, submitInput());
      await expect(
        service.revokeSelfie(String(selfie._id), 'admin-1', '   '),
      ).rejects.toThrow(BadRequestException);
    });

    it('[NP] refuses to revoke the same selfie twice', async () => {
      const courier = await seedCourier('courier-9');
      const selfie = await service.submitSelfie(courier, submitInput());
      await service.revokeSelfie(String(selfie._id), 'admin-1', 'bad photo');
      await expect(
        service.revokeSelfie(String(selfie._id), 'admin-1', 'bad photo'),
      ).rejects.toThrow(BadRequestException);
    });

    it('[NP] unknown selfie id throws NotFound', async () => {
      await expect(
        service.revokeSelfie('507f1f77bcf86cd799439011', 'admin-1', 'reason'),
      ).rejects.toThrow(NotFoundException);
    });

    it('[SEC] revoking a superseded row leaves the live photo untouched', async () => {
      const courier = await seedCourier('courier-10');
      const first = await service.submitSelfie(courier, submitInput());
      const second = await service.submitSelfie(
        courier,
        submitInput({ base64: jpegBase64('second') }),
      );

      // Acting on the old row is a records action; it must not knock the
      // courier offline by clearing the photo they are currently using.
      await service.revokeSelfie(String(first._id), 'admin-1', 'housekeeping');

      const user = await userModel.findById('courier-10').exec();
      expect(user?.photoUrl).toBe(second.publicUrl);
      expect(user?.selfieStatus).toBe(CourierSelfieStatus.ACTIVE);
    });
  });

  // -------------------------------------------------------------------------
  // Queue + erasure
  // -------------------------------------------------------------------------

  describe('reviewQueue', () => {
    it('[HP] returns only live selfies, newest first', async () => {
      const a = await seedCourier('courier-11');
      const b = await seedCourier('courier-12');
      await service.submitSelfie(a, submitInput());
      const bSelfie = await service.submitSelfie(b, submitInput());
      await service.revokeSelfie(String(bSelfie._id), 'admin-1', 'blurry');

      const queue = await service.reviewQueue();

      expect(queue).toHaveLength(1);
      expect(queue[0].courierUid).toBe('courier-11');
    });

    it('[NP] clamps an oversized limit', async () => {
      const queue = await service.reviewQueue(9999, -5);
      expect(queue).toEqual([]);
    });
  });

  describe('eraseForUser', () => {
    it('[HP] deletes every stored object and row for the courier', async () => {
      const courier = await seedCourier('courier-13');
      await service.submitSelfie(courier, submitInput());
      await service.submitSelfie(
        courier,
        submitInput({ base64: jpegBase64('second') }),
      );

      await service.eraseForUser('courier-13');

      // Both takes, not just the live one — account erasure means the face is
      // gone from the bucket entirely.
      expect(storageMock.delete).toHaveBeenCalledTimes(3); // 1 supersede + 2 erase
      const remaining = await selfieModel
        .find({ courierUid: 'courier-13' })
        .exec();
      expect(remaining).toHaveLength(0);
    });

    it('[HP] is a no-op for a user who never submitted one', async () => {
      await expect(service.eraseForUser('courier-14')).resolves.toBeUndefined();
      expect(storageMock.delete).not.toHaveBeenCalled();
    });
  });
});
