import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  CourierSelfie,
  CourierSelfieDocument,
  CourierSelfieStatus,
} from './schemas/courier-selfie.schema';
import { SubmitCourierSelfieInput } from './dto/submit-courier-selfie.input';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';
import { assertContentMatchesMimeType } from '../media/media.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';

// JPEG only. The client re-encodes through the image manipulator before upload,
// which is what strips EXIF (a raw phone selfie carries GPS, and there is no
// sharp/jimp on this server to strip it after the fact) and keeps the payload
// under the size cap. Narrowing the type here is what makes that non-optional:
// HEIC straight off an iPhone would carry its metadata through, and it has no
// magic-byte matcher in MediaService either.
const ALLOWED_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
};

// Base64 is ~1.33x binary — caps the decoded image at ~5 MB, matching the other
// upload paths. A correctly downscaled selfie lands far under this; the cap is
// here to stop a client that skipped the resize, not as a normal-path limit.
const MAX_BASE64_LENGTH = 7 * 1024 * 1024;

const MAX_QUEUE_LIMIT = 100;

@Injectable()
export class CourierVerificationService {
  private readonly logger = new Logger(CourierVerificationService.name);

  constructor(
    @InjectModel(CourierSelfie.name)
    private readonly selfieModel: Model<CourierSelfieDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Accept a courier's liveness selfie: upload it publicly, retire any previous
   * one, and open the courier's gate.
   *
   * The liveness verdict is the CLIENT's. This method does not attempt to
   * re-derive it — it cannot. What it does guarantee is that the bytes are a
   * real JPEG of sane size, that the key is server-derived, and that the whole
   * submission is on the record for a reviewer to revoke.
   */
  async submitSelfie(
    courier: User,
    input: SubmitCourierSelfieInput,
  ): Promise<CourierSelfie> {
    const extension = ALLOWED_MIME_EXTENSIONS[input.mimeType];
    if (!extension) {
      throw new BadRequestException(
        'A selfie must be a JPEG image. Retake it rather than picking a file.',
      );
    }

    const data = input.base64.includes(',')
      ? input.base64.slice(input.base64.indexOf(',') + 1)
      : input.base64;

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new BadRequestException('The selfie image is not valid base64.');
    }
    if (data.length > MAX_BASE64_LENGTH) {
      throw new BadRequestException('Selfie exceeds the 5 MB size limit.');
    }

    const buffer = Buffer.from(data, 'base64');
    // Reuses the public media path's magic-byte check: the declared MIME type
    // is a client assertion, these are the bytes the file actually starts with.
    assertContentMatchesMimeType(buffer, input.mimeType);

    const key = `profiles/couriers/${courier._id}/${randomUUID()}.${extension}`;
    const publicUrl = await this.storageProvider.upload(
      buffer,
      key,
      input.mimeType,
    );

    const previous = await this.selfieModel
      .findOne({
        courierUid: courier._id,
        status: CourierSelfieStatus.ACTIVE,
      })
      .exec();

    // Retire the old row BEFORE inserting the new one — the partial unique index
    // on (courierUid, status: ACTIVE) rejects a second live row, so doing this
    // in the other order would fail on every retake.
    if (previous) {
      previous.status = CourierSelfieStatus.SUPERSEDED;
      await previous.save();
    }

    const created = await this.selfieModel.create({
      courierUid: courier._id,
      storageKey: key,
      publicUrl,
      status: CourierSelfieStatus.ACTIVE,
      livenessChallenge: input.livenessChallenge,
      livenessMetadata: input.livenessMetadata,
      mimeType: input.mimeType,
      fileSizeBytes: buffer.length,
      submittedAt: new Date(),
      supersedesId: previous ? String(previous._id) : null,
    });

    await this.userModel
      .findByIdAndUpdate(courier._id, {
        $set: {
          photoUrl: publicUrl,
          selfieStatus: CourierSelfieStatus.ACTIVE,
          selfieVerifiedAt: created.submittedAt,
          selfieRevokedReason: null,
        },
      })
      .exec();

    // GqlAuthGuard gates couriers on the cached copy of this document. Without
    // this the courier stays locked out for the rest of the cache TTL despite
    // having just passed — the mutation succeeds and every following request
    // still 401s.
    await this.usersService.invalidateUserCache(String(courier._id));

    // Only the live selfie is ever displayed, so the superseded object is dead
    // weight — and it is a face, which is not the kind of dead weight to leave
    // in a public bucket. Best-effort: a failed cleanup must not fail the
    // retake, which has already succeeded by this point.
    if (previous?.storageKey) {
      await this.storageProvider
        .delete(previous.storageKey)
        .catch((err: unknown) =>
          this.logger.warn(
            `Failed to delete superseded selfie ${previous.storageKey}: ${String(err)}`,
          ),
        );
    }

    return created;
  }

  /** The courier's current selfie, or null when they have never submitted one. */
  async myCurrentSelfie(courierUid: string): Promise<CourierSelfie | null> {
    return this.selfieModel
      .findOne({ courierUid })
      .sort({ submittedAt: -1 })
      .exec();
  }

  /** Newest-first review list for admin/support. */
  async reviewQueue(limit = 25, offset = 0): Promise<CourierSelfie[]> {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_QUEUE_LIMIT);
    const safeOffset = Math.max(offset, 0);
    return this.selfieModel
      .find({ status: CourierSelfieStatus.ACTIVE })
      .sort({ submittedAt: -1 })
      .skip(safeOffset)
      .limit(safeLimit)
      .exec();
  }

  /**
   * Take a selfie down. Re-locks the courier (their next request fails the gate)
   * and removes the image from the public bucket — nulling `photoUrl` alone
   * would leave the face readable at its permanent URL forever.
   */
  async revokeSelfie(
    selfieId: string,
    reviewerUid: string,
    reason: string,
  ): Promise<CourierSelfie> {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException('A reason is required to revoke a selfie.');
    }

    const selfie = await this.selfieModel.findById(selfieId).exec();
    if (!selfie) throw new NotFoundException('Selfie not found');
    if (selfie.status === CourierSelfieStatus.REVOKED) {
      throw new BadRequestException('This selfie has already been revoked.');
    }

    const wasLive = selfie.status === CourierSelfieStatus.ACTIVE;

    selfie.status = CourierSelfieStatus.REVOKED;
    selfie.revokedByUid = reviewerUid;
    selfie.revokedAt = new Date();
    selfie.revocationReason = trimmedReason;
    await selfie.save();

    // Only clear the courier's live state if this row was the live one. Revoking
    // an already-superseded row is a records action and must not disturb the
    // photo the courier is currently using.
    if (wasLive) {
      await this.userModel
        .findByIdAndUpdate(selfie.courierUid, {
          $set: {
            photoUrl: null,
            selfieStatus: CourierSelfieStatus.REVOKED,
            selfieRevokedReason: trimmedReason,
            selfieVerifiedAt: null,
          },
        })
        .exec();

      // Same cache as the submit path, and here it is the revocation that must
      // land: a reviewer pulling a courier's selfie expects them off orders now,
      // not whenever the cached document happens to expire.
      await this.usersService.invalidateUserCache(String(selfie.courierUid));
    }

    await this.storageProvider
      .delete(selfie.storageKey)
      .catch((err: unknown) =>
        this.logger.warn(
          `Failed to delete revoked selfie ${selfie.storageKey}: ${String(err)}`,
        ),
      );

    return selfie;
  }

  /**
   * Erase a courier's selfies during account deletion: drop every stored object
   * and clear the pointers. Called by AccountDeletionService.
   */
  async eraseForUser(courierUid: string): Promise<void> {
    const selfies = await this.selfieModel.find({ courierUid }).exec();
    for (const selfie of selfies) {
      if (!selfie.storageKey) continue;
      await this.storageProvider
        .delete(selfie.storageKey)
        .catch((err: unknown) =>
          this.logger.warn(
            `Failed to delete selfie ${selfie.storageKey} during erasure: ${String(err)}`,
          ),
        );
    }
    await this.selfieModel.deleteMany({ courierUid }).exec();
  }
}
