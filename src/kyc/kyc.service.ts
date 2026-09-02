import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  KycDocument,
  KycDocumentDocument,
  KycDocumentStatus,
  KycDocumentType,
  KycExpiryPolicy,
  KycProviderType,
  KYC_ALLOWED_DOCUMENT_TYPES,
  KYC_POLICY_VERSION,
  KycRejectionReason,
  KYC_REJECTION_REASON_TEXT,
  KYC_DOCUMENT_EXPIRY_POLICY,
  KYC_DOCUMENT_LABELS,
  GovernmentIdType,
  GOVERNMENT_ID_DOCUMENT_TYPES,
  requiredKycDocumentTypes,
} from './schemas/kyc-document.schema';
import {
  KycAuditEvent,
  KycAuditEventDocument,
  KycAuditEventType,
} from './schemas/kyc-audit-event.schema';
import { SubmitKycDocumentInput } from './dto/submit-kyc-document.input';
import { KycDocumentTypeStatus, MyKycStatus } from './models/kyc-status.model';
import {
  Branch,
  BranchDocument,
  BranchVerificationStatus,
} from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
  VerificationStatus as WasherVerificationStatus,
} from '../washer/schemas/washer-profile.schema';
import {
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  STORAGE_PROVIDER,
} from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import {
  KycReviewQueueItem,
  PaginatedKycReviewQueue,
} from './models/kyc-review-queue.model';
import { NotificationsService } from '../notifications/notifications.service';
import type { PushPayload } from '../notifications/notifications.service';
import {
  NotificationCategory,
  NotificationType,
} from '../notifications/notification.enums';
import { UsersService } from '../users/users.service';
import { assertContentMatchesMimeType } from '../media/media.service';
import {
  KycAuditEventView,
  KycAuditFilterInput,
  KycMetrics,
  KycProviderDetail,
  KycProviderDocumentView,
  KycProviderFilterInput,
  KycProviderSummary,
  PaginatedKycAuditEvents,
  PaginatedKycProviderSummary,
} from './models/kyc-monitoring.model';

// Admin search terms go into a RegExp — escape them so a stray "(" is a
// literal, not a syntax error, and a ".*" can't be used to force a table scan.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Evidence accepts what the certification UI advertises (GAP-M-020):
// images (incl. HEIC), PDF, and DOCX. Wider than the public branding
// allowlist on purpose — these files are never served publicly.
const KYC_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
};

// Base64 is ~1.33x binary — this caps the decoded file at ~5 MB, matching
// the FE's advertised limit.
const MAX_BASE64_LENGTH = 7 * 1024 * 1024;

// Selfie formats we are willing to republish as a washer's public avatar and
// store logo. A strict subset of the accepted KYC types: HEIC and PDF are valid
// evidence but render nowhere useful, and a profile picture that shows as a
// broken image is worse than none. See applyWasherSelfieAsPublicPhoto.
const PUBLISHABLE_SELFIE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const REVIEWER_ROLES = ['admin', 'support'];

const MAX_REVIEW_QUEUE_LIMIT = 100;

// Statuses a reviewer may act on.
const REVIEWABLE_STATUSES = [
  KycDocumentStatus.SUBMITTED,
  KycDocumentStatus.UNDER_REVIEW,
];

// Mirrors BranchVerificationStatus / VerificationStatus, which are kept
// identical by design. Declared as a union rather than importing one of them
// so neither provider type reads as the canonical one.
type ProviderVerificationStatus =
  'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED';

interface ResolvedProvider {
  providerId: string;
  providerType: KycProviderType;
  ownerUid: string;
  verificationStatus: string;
  verifiedAt?: Date | null;
  rejectionReason?: string | null;
}

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @InjectModel(KycDocument.name)
    private readonly kycDocumentModel: Model<KycDocumentDocument>,
    @InjectModel(KycAuditEvent.name)
    private readonly auditModel: Model<KycAuditEventDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerProfileModel: Model<WasherProfileDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly notifications: NotificationsService,
    private readonly usersService: UsersService,
  ) {}

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private isReviewer(user: User): boolean {
    const role = user.role as unknown as Role;
    return REVIEWER_ROLES.includes(role?.roleId);
  }

  private async audit(
    event: KycAuditEventType,
    actorUid: string,
    provider: { providerId: string; providerType: KycProviderType },
    documentId?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.auditModel.create({
      event,
      actorUid,
      documentId,
      providerId: provider.providerId,
      providerType: provider.providerType,
      details,
    });
  }

  /**
   * Resolves the provider entity and enforces that `user` owns it.
   * For WASHER the profile is derived from the caller when providerId is
   * omitted. Cross-provider access throws ForbiddenException.
   */
  private async resolveOwnedProvider(
    user: User,
    providerType: KycProviderType,
    providerId?: string | null,
  ): Promise<ResolvedProvider> {
    if (providerType === KycProviderType.MERCHANT_BRANCH) {
      if (!providerId) {
        throw new BadRequestException(
          'providerId (branch) is required for merchant KYC.',
        );
      }
      const branch = await this.branchModel.findById(providerId).exec();
      if (!branch) throw new NotFoundException('Branch not found');
      if (branch.uid !== user._id) {
        throw new ForbiddenException(
          'You can only manage KYC documents for your own branch.',
        );
      }
      return {
        providerId: String(branch._id),
        providerType,
        ownerUid: branch.uid,
        verificationStatus: branch.verificationStatus,
        verifiedAt: branch.verifiedAt ?? null,
        rejectionReason: branch.rejectionReason ?? null,
      };
    }

    const profile = await this.washerProfileModel
      .findOne({ uid: user._id })
      .exec();
    if (!profile) throw new NotFoundException('Washer profile not found');
    if (providerId && providerId !== String(profile._id)) {
      throw new ForbiddenException(
        'You can only manage KYC documents for your own washer profile.',
      );
    }
    return {
      providerId: String(profile._id),
      providerType,
      ownerUid: profile.uid,
      verificationStatus: profile.verificationStatus,
      verifiedAt: profile.verifiedAt ?? null,
      rejectionReason: profile.rejectionReason ?? null,
    };
  }

  /** Loads the provider a document belongs to (no ownership check). */
  private async loadProviderForDocument(
    doc: KycDocument,
  ): Promise<ResolvedProvider> {
    if (doc.providerType === KycProviderType.MERCHANT_BRANCH) {
      const branch = await this.branchModel.findById(doc.providerId).exec();
      if (!branch) throw new NotFoundException('Branch not found');
      return {
        providerId: String(branch._id),
        providerType: doc.providerType,
        ownerUid: branch.uid,
        verificationStatus: branch.verificationStatus,
      };
    }
    const profile = await this.washerProfileModel
      .findById(doc.providerId)
      .exec();
    if (!profile) throw new NotFoundException('Washer profile not found');
    return {
      providerId: String(profile._id),
      providerType: doc.providerType,
      ownerUid: profile.uid,
      verificationStatus: profile.verificationStatus,
    };
  }

  private async setProviderVerification(
    provider: ResolvedProvider,
    status: ProviderVerificationStatus,
    reviewerUid: string | null,
    rejectionReason: string | null,
  ): Promise<void> {
    const update = {
      verificationStatus: status,
      verifiedAt: status === 'APPROVED' ? new Date() : null,
      verifiedBy: status === 'APPROVED' ? reviewerUid : null,
      rejectionReason,
      // Stamp the policy this approval was granted under. Left untouched when
      // the provider is not APPROVED so a provider that later drops back to
      // PENDING keeps no misleading version, and re-approval re-stamps.
      ...(status === 'APPROVED'
        ? { verificationPolicyVersion: KYC_POLICY_VERSION }
        : { verificationPolicyVersion: null }),
    };
    if (provider.providerType === KycProviderType.MERCHANT_BRANCH) {
      await this.branchModel
        .findByIdAndUpdate(provider.providerId, {
          $set: {
            ...update,
            verificationStatus: status,
          },
        })
        .exec();
    } else {
      await this.washerProfileModel
        .findByIdAndUpdate(provider.providerId, {
          $set: {
            ...update,
            verificationStatus: status,
          },
        })
        .exec();
    }
  }

  /**
   * Single source of truth for the provider-level badge. Derived from the live
   * document set rather than patched at each call site, so the three lifecycle
   * entry points (submit / approve / reject) can never disagree:
   *
   *   any required document REJECTED       → REJECTED (carrying its reason)
   *   all required documents satisfied     → APPROVED
   *   all required documents submitted,    → IN_REVIEW
   *     none rejected
   *   otherwise                            → PENDING
   *
   * The old "resubmitting after a rejection resets to PENDING" special case
   * falls out of this for free: the resubmitted document is SUBMITTED, so no
   * required document is REJECTED any more.
   *
   * Returns the status it settled on, and whether that was a change — callers
   * use this to decide whether to write an audit event or send a push.
   */
  private async recomputeProviderVerification(
    provider: ResolvedProvider,
    reviewerUid: string | null,
  ): Promise<{ status: ProviderVerificationStatus; changed: boolean }> {
    const byType = await this.latestDocumentsByType(provider.providerId);
    const required = requiredKycDocumentTypes(
      provider.providerType,
      this.claimedGovernmentIdType(byType.values()),
    );

    const rejected = required
      .map((type) => byType.get(type))
      .find((doc) => doc?.status === KycDocumentStatus.REJECTED);

    let status: ProviderVerificationStatus;
    let rejectionReason: string | null = null;

    if (rejected) {
      status = 'REJECTED';
      rejectionReason = rejected.rejectionReason ?? null;
    } else if (
      required.every((type) => this.satisfiesRequirement(byType.get(type)))
    ) {
      status = 'APPROVED';
    } else if (required.every((type) => byType.get(type) != null)) {
      // Everything asked for is in hand and nothing is rejected — the provider
      // has no action left to take, only a reviewer does.
      status = 'IN_REVIEW';
    } else {
      status = 'PENDING';
    }

    const changed = provider.verificationStatus !== status;
    await this.setProviderVerification(
      provider,
      status,
      status === 'APPROVED' ? reviewerUid : null,
      rejectionReason,
    );
    // Keep the in-memory copy consistent for callers that read it afterwards.
    provider.verificationStatus = status;
    return { status, changed };
  }

  /**
   * A requirement is satisfied only by an APPROVED document that has not
   * expired. Nothing here downgrades an already-granted badge — this only
   * governs whether one may be granted.
   */
  private satisfiesRequirement(doc: KycDocument | undefined): boolean {
    if (doc?.status !== KycDocumentStatus.APPROVED) return false;
    return !(doc.expiresAt && doc.expiresAt.getTime() <= Date.now());
  }

  /**
   * The government ID a provider claimed, read off its live front-of-ID
   * document — or null before one has been submitted.
   *
   * Feed this to requiredKycDocumentTypes: it is what decides whether the back
   * of the ID is required. Callers pass documents newest-first (or a
   * latest-per-type map's values); SUPERSEDED ones are skipped so a replaced
   * claim never outranks the current one.
   */
  private claimedGovernmentIdType(
    docs: Iterable<KycDocument>,
  ): GovernmentIdType | null {
    for (const doc of docs) {
      if (doc.status === KycDocumentStatus.SUPERSEDED) continue;
      if (!GOVERNMENT_ID_DOCUMENT_TYPES.includes(doc.documentType)) continue;
      if (doc.governmentIdType) return doc.governmentIdType;
    }
    return null;
  }

  /** Latest document per type, ignoring SUPERSEDED ones. */
  private async latestDocumentsByType(
    providerId: string,
  ): Promise<Map<KycDocumentType, KycDocument>> {
    const docs = await this.kycDocumentModel
      .find({
        providerId,
        status: { $ne: KycDocumentStatus.SUPERSEDED },
      })
      .sort({ submittedAt: -1 })
      .exec();
    const byType = new Map<KycDocumentType, KycDocument>();
    for (const doc of docs) {
      if (!byType.has(doc.documentType)) byType.set(doc.documentType, doc);
    }
    return byType;
  }

  // ------------------------------------------------------------------
  // Provider-facing lifecycle
  // ------------------------------------------------------------------

  async submitDocument(
    user: User,
    input: SubmitKycDocumentInput,
  ): Promise<KycDocument> {
    const provider = await this.resolveOwnedProvider(
      user,
      input.providerType,
      input.providerId,
    );

    // Allowed, not required — a type retired from the required set stays
    // submittable so in-flight documents can still be replaced and reviewed.
    const allowedTypes = KYC_ALLOWED_DOCUMENT_TYPES[input.providerType];
    if (!allowedTypes.includes(input.documentType)) {
      throw new BadRequestException(
        `Document type ${input.documentType} does not apply to ${input.providerType}.`,
      );
    }

    // The claimed ID type is only meaningful on the front of a government ID,
    // and it is REQUIRED there: it decides whether the back is required, and a
    // blank one leaves the reviewer guessing at exactly the thing this field
    // exists to record. Unlike the liveness fields below, sending it on any
    // other type is silently dropped rather than rejected — a confused client
    // should not fail an otherwise valid upload.
    const isGovernmentId = GOVERNMENT_ID_DOCUMENT_TYPES.includes(
      input.documentType,
    );
    if (isGovernmentId && !input.governmentIdType) {
      throw new BadRequestException(
        'Select which government-issued ID this is before uploading it.',
      );
    }

    const expiryPolicy = KYC_DOCUMENT_EXPIRY_POLICY[input.documentType];
    if (expiryPolicy === KycExpiryPolicy.REQUIRED && !input.expiresAt) {
      throw new BadRequestException(
        'An expiry date is required for this document.',
      );
    }
    // A document that is already expired can never satisfy its requirement,
    // so reject it at the door rather than after a reviewer wastes time on it.
    const expiresAt =
      expiryPolicy === KycExpiryPolicy.NONE ? null : (input.expiresAt ?? null);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'This document has already expired. Upload a currently valid one.',
      );
    }

    const ext = KYC_MIME_EXTENSIONS[input.mimeType];
    if (!ext) {
      throw new BadRequestException(
        'File type not supported. Upload an image (JPG/PNG/HEIC), PDF, or Word document (.docx).',
      );
    }

    const data = input.base64.includes(',')
      ? input.base64.split(',')[1]
      : input.base64;
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new BadRequestException(
        'The uploaded file is corrupted or invalid.',
      );
    }
    if (data.length > MAX_BASE64_LENGTH) {
      throw new BadRequestException('File exceeds the 5 MB size limit');
    }
    const buffer = Buffer.from(data, 'base64');

    // Server-derived storage path (RISK-P0-002) — the caller never chooses
    // the folder or key.
    const key = `kyc/${provider.providerType.toLowerCase()}/${provider.providerId}/${input.documentType.toLowerCase()}/${randomUUID()}.${ext}`;
    const storageObjectKey = await this.storageProvider.uploadPrivate(
      buffer,
      key,
      input.mimeType,
    );

    // Resubmission: any live (non-terminal-by-supersession) document of the
    // same type gets marked SUPERSEDED; the new document points back at the
    // most recent one it replaced.
    const previous = await this.kycDocumentModel
      .find({
        providerId: provider.providerId,
        documentType: input.documentType,
        status: { $ne: KycDocumentStatus.SUPERSEDED },
      })
      .sort({ submittedAt: -1 })
      .exec();

    const doc = await this.kycDocumentModel.create({
      providerId: provider.providerId,
      providerType: provider.providerType,
      ownerUid: provider.ownerUid,
      documentType: input.documentType,
      storageObjectKey,
      mimeType: input.mimeType,
      fileSizeBytes: buffer.length,
      status: KycDocumentStatus.SUBMITTED,
      submittedAt: new Date(),
      expiresAt,
      governmentIdType: isGovernmentId ? input.governmentIdType : null,
      supersedesDocumentId: previous.length
        ? String(previous[0]._id)
        : undefined,
      // Only ever recorded against a selfie: it describes a face capture, and
      // accepting it on a business permit would put meaningless numbers in
      // front of a reviewer. Dropped silently rather than rejected — a client
      // sending it elsewhere is confused, not hostile.
      ...(input.documentType === KycDocumentType.SELFIE && {
        livenessChallenge: input.livenessChallenge ?? null,
        livenessMetadata: input.livenessMetadata ?? null,
      }),
    });

    if (previous.length) {
      await this.kycDocumentModel
        .updateMany(
          { _id: { $in: previous.map((d) => d._id) } },
          {
            $set: {
              status: KycDocumentStatus.SUPERSEDED,
              claimedByUid: null,
              claimedAt: null,
            },
          },
        )
        .exec();
      for (const old of previous) {
        await this.audit(
          KycAuditEventType.DOCUMENT_SUPERSEDED,
          user._id,
          provider,
          String(old._id),
          { supersededBy: String(doc._id) },
        );
      }
    }

    // A washer's selfie doubles as her public face — see the method's docblock.
    // Deliberately after the document is durably created, and deliberately
    // unable to fail this mutation.
    if (
      provider.providerType === KycProviderType.WASHER &&
      input.documentType === KycDocumentType.SELFIE
    ) {
      await this.applyWasherSelfieAsPublicPhoto(
        provider,
        buffer,
        input.mimeType,
        ext,
      );
    }

    // Re-derive the badge from the new document set: a resubmission clears a
    // stale REJECTED verdict, and the final missing upload flips the provider
    // to IN_REVIEW.
    await this.recomputeProviderVerification(provider, null);

    await this.audit(
      KycAuditEventType.DOCUMENT_SUBMITTED,
      user._id,
      provider,
      String(doc._id),
      { documentType: input.documentType, fileSizeBytes: buffer.length },
    );
    this.logger.log(
      `KYC document submitted: ${doc._id} (${input.documentType}) for ${provider.providerType} ${provider.providerId}`,
    );
    return doc;
  }

  /**
   * Publish a washer's KYC selfie as her avatar and store logo, with no review.
   *
   * Mirrors the courier flow (CourierVerificationService.submitSelfie): the face
   * a customer sees is the face we hold identity evidence for, and making that
   * wait on a reviewer left every new washer facing a blank avatar and a blank
   * storefront for as long as the queue was deep. Approval still gates
   * `verificationStatus` and the verified badge — it just no longer gates the
   * picture.
   *
   * The private evidence copy written by the caller is untouched and still
   * reviewable; this is a SECOND, public copy.
   *
   * Two deliberate constraints:
   *
   *  1. This can never fail the submission. The KYC document is the thing the
   *     washer came to do and is already durably written by this point; losing
   *     it because a decorative copy failed would be the worse outcome. Errors
   *     are logged and swallowed.
   *  2. HEIC is skipped rather than published. It is an accepted KYC type, but
   *     no browser renders it, so a HEIC "avatar" is a broken image everywhere
   *     it appears. It also has no magic-byte matcher, so the content check
   *     below would reject it anyway. In practice the selfie card is
   *     camera-only and expo-image-picker hands back JPEG.
   */
  private async applyWasherSelfieAsPublicPhoto(
    provider: ResolvedProvider,
    buffer: Buffer,
    mimeType: string,
    ext: string,
  ): Promise<void> {
    try {
      if (!PUBLISHABLE_SELFIE_MIME_TYPES.has(mimeType)) {
        this.logger.warn(
          `Selfie for washer ${provider.providerId} not published as profile photo: ${mimeType} is not browser-renderable`,
        );
        return;
      }
      // The declared MIME type is a client assertion; these are the bytes the
      // file actually starts with.
      assertContentMatchesMimeType(buffer, mimeType);

      const washer = await this.washerProfileModel
        .findById(provider.providerId)
        .select('selfiePublicObjectKey')
        .exec();
      const previousKey = washer?.selfiePublicObjectKey ?? null;

      const key = `profiles/washers/${provider.providerId}/${randomUUID()}.${ext}`;
      const publicUrl = await this.storageProvider.upload(
        buffer,
        key,
        mimeType,
      );

      await this.washerProfileModel
        .findByIdAndUpdate(provider.providerId, {
          $set: {
            photoUrl: publicUrl,
            // Her face IS the storefront for a home washer — there is no shop
            // to photograph. See the store editor, which no longer offers a
            // logo upload for washers.
            logoUrl: publicUrl,
            selfiePublicObjectKey: key,
          },
        })
        .exec();

      await this.userModel
        .findByIdAndUpdate(provider.ownerUid, {
          $set: {
            photoUrl: publicUrl,
            selfieStatus: 'ACTIVE',
            selfieVerifiedAt: new Date(),
            selfieRevokedReason: null,
          },
        })
        .exec();

      // The guard reads the gate state off the cached user document, so without
      // this the new photo stays invisible for the rest of the cache TTL.
      await this.usersService.invalidateUserCache(provider.ownerUid);

      // Only the live selfie is ever shown, so the superseded object is dead
      // weight — and it is a face, which is not the kind of dead weight to leave
      // in a public bucket.
      if (previousKey && previousKey !== key) {
        await this.storageProvider
          .delete(previousKey)
          .catch((err: unknown) =>
            this.logger.warn(
              `Failed to delete superseded washer selfie ${previousKey}: ${String(err)}`,
            ),
          );
      }
    } catch (err: unknown) {
      this.logger.error(
        `Failed to publish selfie as profile photo for washer ${provider.providerId}: ${String(err)}`,
      );
    }
  }

  async myKycStatus(
    user: User,
    providerType: KycProviderType,
    providerId?: string | null,
  ): Promise<MyKycStatus> {
    const provider = await this.resolveOwnedProvider(
      user,
      providerType,
      providerId,
    );
    const byType = await this.latestDocumentsByType(provider.providerId);
    const governmentIdType = this.claimedGovernmentIdType(byType.values());
    const required = requiredKycDocumentTypes(providerType, governmentIdType);

    const documents: KycDocumentTypeStatus[] = KYC_ALLOWED_DOCUMENT_TYPES[
      providerType
    ].map((documentType) => {
      const doc = byType.get(documentType);
      return {
        documentType,
        required: required.includes(documentType),
        expiryPolicy: KYC_DOCUMENT_EXPIRY_POLICY[documentType],
        status: doc?.status ?? null,
        documentId: doc ? String(doc._id) : null,
        submittedAt: doc?.submittedAt ?? null,
        reviewedAt: doc?.reviewedAt ?? null,
        expiresAt: doc?.expiresAt ?? null,
        rejectionReason: doc?.rejectionReason ?? null,
      };
    });

    return {
      providerId: provider.providerId,
      providerType,
      verificationStatus: provider.verificationStatus,
      verifiedAt: provider.verifiedAt ?? null,
      providerRejectionReason: provider.rejectionReason ?? null,
      governmentIdType,
      documents,
    };
  }

  // ------------------------------------------------------------------
  // Admin/Support review
  // ------------------------------------------------------------------

  /**
   * Review queue, oldest first.
   * `claimed` filters on the review claim: true ⇒ only documents a reviewer
   * currently holds (UNDER_REVIEW), false ⇒ only unclaimed ones, undefined/null
   * ⇒ everything awaiting review.
   */
  async reviewQueue(
    claimed?: boolean | null,
    limit = 25,
    offset = 0,
    status?: KycDocumentStatus[] | null,
  ): Promise<PaginatedKycReviewQueue> {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_REVIEW_QUEUE_LIMIT);
    const safeOffset = Math.max(offset, 0);
    // Defaults to the actionable queue; an explicit status list widens it to
    // decided/superseded documents so admins can audit past decisions.
    const filter: Record<string, unknown> = {
      status: { $in: status?.length ? status : REVIEWABLE_STATUSES },
    };
    if (claimed === true) filter.claimedByUid = { $ne: null };
    if (claimed === false) filter.claimedByUid = null;

    const [docs, total] = await Promise.all([
      this.kycDocumentModel
        .find(filter)
        .sort({ submittedAt: 1 })
        .skip(safeOffset)
        .limit(safeLimit)
        .exec(),
      this.kycDocumentModel.countDocuments(filter).exec(),
    ]);

    return {
      data: await this.decorateQueue(docs),
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  /**
   * Attaches the provider name, owner email, and claiming reviewer's email a
   * reviewer needs. Batched by provider type and user so one page costs three
   * queries, not 3N — owners and claiming reviewers are both users, so they
   * resolve through a single lookup.
   */
  private async decorateQueue(
    docs: KycDocument[],
  ): Promise<KycReviewQueueItem[]> {
    if (!docs.length) return [];

    const branchIds = docs
      .filter((d) => d.providerType === KycProviderType.MERCHANT_BRANCH)
      .map((d) => d.providerId);
    const washerIds = docs
      .filter((d) => d.providerType === KycProviderType.WASHER)
      .map((d) => d.providerId);
    const userUids = [
      ...new Set([
        ...docs.map((d) => d.ownerUid),
        ...docs
          .map((d) => d.claimedByUid)
          .filter((uid): uid is string => !!uid),
      ]),
    ];

    const [branches, washers, users] = await Promise.all([
      // `as any` on the _id $in filters matches the codebase's existing
      // workaround for Mongoose's strict ObjectId-vs-string filter typing
      // (see online-orders.service.ts:517).
      branchIds.length
        ? this.branchModel
            .find({ _id: { $in: branchIds } } as any)
            .select('branchName')
            .exec()
        : [],
      washerIds.length
        ? this.washerProfileModel
            .find({ _id: { $in: washerIds } } as any)
            .select('displayName')
            .exec()
        : [],
      this.userModel
        .find({ _id: { $in: userUids } } as any)
        .select('email')
        .exec(),
    ]);

    const names = new Map<string, string>();
    for (const b of branches) names.set(String(b._id), b.branchName);
    for (const w of washers) names.set(String(w._id), w.displayName);
    const emails = new Map(users.map((u) => [String(u._id), u.email]));

    return docs.map((document) => ({
      document,
      // Null when the provider or owner was deleted — the row still lists so
      // an orphaned document can be dismissed from the queue.
      providerName: names.get(document.providerId) ?? null,
      ownerEmail: emails.get(document.ownerUid) ?? null,
      claimedByEmail: document.claimedByUid
        ? (emails.get(document.claimedByUid) ?? null)
        : null,
    }));
  }

  /**
   * Claim a SUBMITTED document for review (SUBMITTED → UNDER_REVIEW),
   * recording the reviewer holding it.
   *
   * Concurrency decision (documented in contract.md): claims are EXCLUSIVE —
   * no silent takeover. Re-claiming a document you already hold is idempotent
   * (same claimedAt preserved, no duplicate audit event); claiming one another
   * reviewer holds is refused with ForbiddenException. Approve/reject stay
   * available to any reviewer so a stale claim can never deadlock the queue —
   * an approve/reject over someone else's claim appends a
   * DOCUMENT_CLAIM_OVERRIDDEN audit event.
   */
  /**
   * Claim an entire provider case — every document of theirs a reviewer may
   * still act on.
   *
   * Claiming per document allowed two reviewers to hold different halves of
   * one identity at the same time (one on the ID front, another on the selfie),
   * which is precisely the comparison a reviewer needs to make alone. The unit
   * of review is the provider, so the claim is too.
   *
   * Idempotent for the holder. Refuses if anyone else holds any part of it.
   */
  async claimCaseForReview(
    reviewer: User,
    providerType: KycProviderType,
    providerId: string,
  ): Promise<KycProviderDetail> {
    const provider = await this.loadProviderIdentity(providerType, providerId);
    if (provider.ownerUid === reviewer._id) {
      throw new ForbiddenException('You cannot review your own KYC case.');
    }

    const open = await this.kycDocumentModel
      .find({
        providerId,
        providerType,
        status: { $in: REVIEWABLE_STATUSES },
      })
      .exec();

    if (!open.length) {
      throw new BadRequestException('This case has nothing left to review.');
    }

    const heldByOther = open.find(
      (d) => d.claimedByUid && d.claimedByUid !== reviewer._id,
    );
    if (heldByOther) {
      const holder = await this.userModel
        .findById(heldByOther.claimedByUid as unknown as string)
        .select('email')
        .exec();
      throw new ForbiddenException(
        `This case is already being reviewed by ${holder?.email ?? 'another reviewer'}.`,
      );
    }

    const alreadyMine = open.every((d) => d.claimedByUid === reviewer._id);
    if (!alreadyMine) {
      await this.kycDocumentModel
        .updateMany(
          { _id: { $in: open.map((d) => d._id) } },
          {
            $set: {
              status: KycDocumentStatus.UNDER_REVIEW,
              claimedByUid: reviewer._id,
              claimedAt: new Date(),
            },
          },
        )
        .exec();

      await this.audit(
        KycAuditEventType.CASE_CLAIMED_FOR_REVIEW,
        reviewer._id,
        provider,
        undefined,
        { documentCount: open.length },
      );
    }

    return this.providerDetail(providerType, providerId);
  }

  /** Hand a claimed case back to the queue without deciding anything. */
  async releaseCase(
    reviewer: User,
    providerType: KycProviderType,
    providerId: string,
  ): Promise<KycProviderDetail> {
    const provider = await this.loadProviderIdentity(providerType, providerId);

    const mine = await this.kycDocumentModel
      .find({ providerId, providerType, claimedByUid: reviewer._id })
      .exec();

    if (mine.length) {
      await this.kycDocumentModel
        .updateMany(
          { _id: { $in: mine.map((d) => d._id) } },
          {
            $set: {
              // Back to SUBMITTED so the case reappears as unclaimed work.
              status: KycDocumentStatus.SUBMITTED,
              claimedByUid: null,
              claimedAt: null,
            },
          },
        )
        .exec();
      await this.audit(
        KycAuditEventType.CASE_RELEASED,
        reviewer._id,
        provider,
        undefined,
        { documentCount: mine.length },
      );
    }

    return this.providerDetail(providerType, providerId);
  }

  async claimDocumentForReview(
    reviewer: User,
    documentId: string,
  ): Promise<KycDocument> {
    const doc = await this.kycDocumentModel.findById(documentId).exec();
    if (!doc) throw new NotFoundException('KYC document not found');
    const provider = await this.loadProviderForDocument(doc);

    if (provider.ownerUid === reviewer._id) {
      throw new ForbiddenException('You cannot review your own KYC documents.');
    }
    if (!REVIEWABLE_STATUSES.includes(doc.status)) {
      throw new BadRequestException(
        `Document is ${doc.status} and can no longer be reviewed.`,
      );
    }

    // Idempotent re-claim by the holder — no state change, no second audit row.
    if (doc.claimedByUid === reviewer._id) return doc;

    if (doc.claimedByUid) {
      throw new ForbiddenException(
        'This document is already being reviewed by another reviewer.',
      );
    }

    doc.status = KycDocumentStatus.UNDER_REVIEW;
    doc.claimedByUid = reviewer._id;
    doc.claimedAt = new Date();
    await doc.save();

    await this.audit(
      KycAuditEventType.DOCUMENT_CLAIMED_FOR_REVIEW,
      reviewer._id,
      provider,
      String(doc._id),
      { documentType: doc.documentType },
    );
    return doc;
  }

  /**
   * Records (and clears) a claim held by a DIFFERENT reviewer at the moment
   * this reviewer approves/rejects. Returning the claim to null keeps the
   * queue's claimed/unclaimed filter meaningful for live documents only.
   */
  private async noteClaimOverride(
    doc: KycDocumentDocument,
    reviewer: User,
    provider: ResolvedProvider,
  ): Promise<void> {
    if (doc.claimedByUid && doc.claimedByUid !== reviewer._id) {
      await this.audit(
        KycAuditEventType.DOCUMENT_CLAIM_OVERRIDDEN,
        reviewer._id,
        provider,
        String(doc._id),
        { claimedByUid: doc.claimedByUid, claimedAt: doc.claimedAt },
      );
    }
  }

  async approveDocument(
    reviewer: User,
    documentId: string,
    // Set when this decision is part of a whole-case review: the case sends one
    // consolidated result instead of a push per document.
    silent = false,
  ): Promise<KycDocument> {
    const doc = await this.kycDocumentModel.findById(documentId).exec();
    if (!doc) throw new NotFoundException('KYC document not found');
    const provider = await this.loadProviderForDocument(doc);

    // Providers can never self-approve — even if a provider account somehow
    // carried a reviewer role, approving evidence you own is forbidden.
    if (provider.ownerUid === reviewer._id) {
      throw new ForbiddenException('You cannot review your own KYC documents.');
    }
    if (!REVIEWABLE_STATUSES.includes(doc.status)) {
      throw new BadRequestException(
        `Document is ${doc.status} and can no longer be reviewed.`,
      );
    }

    await this.noteClaimOverride(doc, reviewer, provider);

    doc.status = KycDocumentStatus.APPROVED;
    doc.reviewedAt = new Date();
    doc.reviewedByUid = reviewer._id;
    doc.rejectionReason = null as unknown as string;
    doc.claimedByUid = null as unknown as string;
    doc.claimedAt = null as unknown as Date;
    await doc.save();

    await this.audit(
      KycAuditEventType.DOCUMENT_APPROVED,
      reviewer._id,
      provider,
      String(doc._id),
    );

    // When every required document type is APPROVED, flip the provider's
    // badge to APPROVED. Badge only — no marketplace/discovery/top-up gate.
    const { status, changed } = await this.recomputeProviderVerification(
      provider,
      reviewer._id,
    );
    if (status === 'APPROVED' && changed) {
      await this.audit(
        KycAuditEventType.PROVIDER_VERIFICATION_APPROVED,
        reviewer._id,
        provider,
      );
      this.logger.log(
        `Provider fully KYC-verified: ${provider.providerType} ${provider.providerId}`,
      );
      // Only on the transition — approving documents 1..5 must not each claim
      // the provider is verified.
      if (!silent)
        await this.notify(provider.ownerUid, {
          title: "You're verified!",
          body:
            provider.providerType === KycProviderType.MERCHANT_BRANCH
              ? 'Your business verification is complete. The Verified badge is now on your store.'
              : 'Your identity verification is complete. The Verified Washer badge is now on your profile.',
          data: {
            type: 'KYC_APPROVED',
            providerId: provider.providerId,
            providerType: provider.providerType,
          },
        });
    }
    return doc;
  }

  /**
   * Reject one document with a STRUCTURED reason.
   *
   * `rejectionReason` stays the composed provider-facing sentence because the
   * partner app renders it verbatim; the code and note are stored alongside so
   * the review UI and any later analysis read structure, not prose.
   */
  async rejectDocument(
    reviewer: User,
    documentId: string,
    reasonCode: KycRejectionReason,
    note?: string | null,
    silent = false,
  ): Promise<KycDocument> {
    const standard = KYC_REJECTION_REASON_TEXT[reasonCode];
    if (!standard) {
      throw new BadRequestException('A valid rejection reason is required.');
    }
    // OTHER carries no useful standard text on its own — make the reviewer say
    // what is wrong, or the provider is told to fix something unspecified.
    if (reasonCode === KycRejectionReason.OTHER && !note?.trim()) {
      throw new BadRequestException(
        'Describe what needs fixing when the reason is "Other".',
      );
    }
    const reason = note?.trim() ? `${standard} ${note.trim()}` : standard;
    const doc = await this.kycDocumentModel.findById(documentId).exec();
    if (!doc) throw new NotFoundException('KYC document not found');
    const provider = await this.loadProviderForDocument(doc);

    if (provider.ownerUid === reviewer._id) {
      throw new ForbiddenException('You cannot review your own KYC documents.');
    }
    if (!REVIEWABLE_STATUSES.includes(doc.status)) {
      throw new BadRequestException(
        `Document is ${doc.status} and can no longer be reviewed.`,
      );
    }

    await this.noteClaimOverride(doc, reviewer, provider);

    doc.status = KycDocumentStatus.REJECTED;
    doc.reviewedAt = new Date();
    doc.reviewedByUid = reviewer._id;
    doc.rejectionReason = reason;
    doc.rejectionReasonCode = reasonCode;
    doc.rejectionNote = note?.trim() || null;
    doc.claimedByUid = null as unknown as string;
    doc.claimedAt = null as unknown as Date;
    await doc.save();

    await this.audit(
      KycAuditEventType.DOCUMENT_REJECTED,
      reviewer._id,
      provider,
      String(doc._id),
      { reason, reasonCode, note: note?.trim() || null },
    );

    // Rejection is provider-level: badge goes REJECTED with the reason.
    // Resubmitting the document type re-derives it (see submitDocument).
    await this.recomputeProviderVerification(provider, null);
    await this.audit(
      KycAuditEventType.PROVIDER_VERIFICATION_REJECTED,
      reviewer._id,
      provider,
      String(doc._id),
      { reason: reason.trim() },
    );

    // Tell the owner what to fix. Sent on every rejection, not just the first —
    // each rejected document is a separate thing they must act on.
    if (!silent)
      await this.notify(provider.ownerUid, {
        title: 'Action needed on your verification',
        body: `${KYC_DOCUMENT_LABELS[doc.documentType] ?? 'A document'} was not accepted: ${reason.trim()}`,
        data: {
          type: 'KYC_REJECTED',
          documentId: String(doc._id),
          documentType: doc.documentType,
          providerId: provider.providerId,
          providerType: provider.providerType,
        },
      });
    return doc;
  }

  /**
   * Apply every decision for one case, then tell the provider ONCE.
   *
   * Deciding documents one at a time pushed a separate notification per
   * document, so a five-document washer could be pinged five times for a single
   * sitting — and the provider still had to assemble "what do I actually need to
   * fix?" themselves. Here the reviewer works through the case and the provider
   * receives one result listing exactly what to replace.
   *
   * Not transactional: each decision is applied in turn (KNOWN_RISKS item 6).
   * A failure part-way leaves earlier decisions applied, which is the same
   * behaviour as deciding them individually.
   */
  async completeCaseReview(
    reviewer: User,
    providerType: KycProviderType,
    providerId: string,
    decisions: Array<{
      documentId: string;
      approve: boolean;
      reasonCode?: KycRejectionReason | null;
      note?: string | null;
    }>,
  ): Promise<KycProviderDetail> {
    if (!decisions.length) {
      throw new BadRequestException('No decisions were submitted.');
    }
    const provider = await this.loadProviderIdentity(providerType, providerId);
    if (provider.ownerUid === reviewer._id) {
      throw new ForbiddenException('You cannot review your own KYC case.');
    }

    const rejected: Array<{ label: string; reason: string }> = [];

    for (const decision of decisions) {
      if (decision.approve) {
        await this.approveDocument(reviewer, decision.documentId, true);
        continue;
      }
      if (!decision.reasonCode) {
        throw new BadRequestException(
          'A rejection reason is required for every document you turn down.',
        );
      }
      const doc = await this.rejectDocument(
        reviewer,
        decision.documentId,
        decision.reasonCode,
        decision.note,
        true,
      );
      rejected.push({
        label: KYC_DOCUMENT_LABELS[doc.documentType] ?? 'A document',
        reason: doc.rejectionReason ?? '',
      });
    }

    // Re-read: the last decision determines where the provider landed.
    const finalProvider = await this.loadProviderIdentity(
      providerType,
      providerId,
    );

    if (rejected.length) {
      await this.notify(provider.ownerUid, {
        title: 'Verification needs attention',
        body: `${rejected.length} item${rejected.length === 1 ? '' : 's'} need${
          rejected.length === 1 ? 's' : ''
        } to be replaced: ${rejected.map((r) => r.label).join(', ')}.`,
        data: {
          type: 'KYC_CASE_ACTION_NEEDED',
          providerId,
          providerType,
          items: JSON.stringify(rejected),
        },
      });
    } else if (finalProvider.verificationStatus === 'APPROVED') {
      await this.notify(provider.ownerUid, {
        title: "You're verified!",
        body: 'Your verification is complete and your Verified badge is live.',
        data: { type: 'KYC_APPROVED', providerId, providerType },
      });
    }

    return this.providerDetail(providerType, providerId);
  }

  /**
   * The `data.type` strings the four call sites already emit, mapped onto the
   * feed's enum. A table rather than a cast so an unrecognised string falls
   * back to a real member instead of writing a value the enum does not have.
   */
  private static readonly KYC_NOTIFICATION_TYPES: Record<
    string,
    NotificationType
  > = {
    KYC_APPROVED: NotificationType.KYC_APPROVED,
    KYC_REJECTED: NotificationType.KYC_REJECTED,
    KYC_CASE_ACTION_NEEDED: NotificationType.KYC_CASE_ACTION_NEEDED,
  };

  /**
   * Best-effort push. NotificationsService already swallows delivery failures,
   * but a lookup failure would still surface here — and the review writes above
   * are non-transactional (KNOWN_RISKS item 6), so a failed push must never
   * roll a completed decision back to the reviewer as an error.
   */
  private async notify(uid: string, payload: PushPayload): Promise<void> {
    try {
      // Routed through notify() rather than sendToUser so the decision also
      // lands in the owner's in-app feed. A verification outcome is exactly the
      // kind of thing a partner needs to find again later, long after the push
      // notification has been swiped away.
      //
      // The `type` already travels in payload.data from all four call sites,
      // so they need no changes — it just has to be mapped onto the enum.
      await this.notifications.notify(
        { uid },
        {
          type:
            KycService.KYC_NOTIFICATION_TYPES[payload.data?.type ?? ''] ??
            NotificationType.KYC_CASE_ACTION_NEEDED,
          category: NotificationCategory.VERIFICATION,
          title: payload.title,
          body: payload.body,
          // Keep every field the call sites already put in payload.data
          // (documentType, reason code, …) — the feed row is the durable copy,
          // so dropping them here would lose detail the push still carried.
          data: { ...payload.data },
        },
      );
    } catch (err) {
      this.logger.warn(
        `KYC push to ${uid} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Admin/Support monitoring
  // ------------------------------------------------------------------

  /**
   * Per-provider rollup — "where does each partner stand", as opposed to the
   * review queue's "what should I work on next".
   *
   * Driven from the provider collections rather than from kyc_documents so a
   * partner who has not started still appears (as PENDING, 0/N). The two
   * collections are paginated by merge: fetch offset+limit from each sorted by
   * the same key, merge, sort, then slice — which is exactly correct for a
   * union sort, at the cost of over-fetching one page.
   */
  /**
   * The `Branch` ids that are washer anchors rather than real laundromats.
   *
   * `WasherProfile.branchId` is a plain string while `Branch._id` is an
   * ObjectId, so anything not castable is dropped here. Mongoose throws a
   * CastError on the whole query if even one `$nin` member is not a valid
   * ObjectId — and this filter feeds the admin verifications page, which would
   * then fail to load entirely rather than merely showing one stray row.
   */
  private async washerAnchorBranchIds(): Promise<Types.ObjectId[]> {
    const anchors = await this.washerProfileModel
      .find()
      .select('branchId')
      .exec();
    return anchors
      .map((w) => w.branchId)
      .filter((id): id is string => !!id && Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
  }

  async providerSummaries(
    filter: KycProviderFilterInput = {},
  ): Promise<PaginatedKycProviderSummary> {
    const limit = Math.min(
      Math.max(filter.limit ?? 25, 1),
      MAX_REVIEW_QUEUE_LIMIT,
    );
    const offset = Math.max(filter.offset ?? 0, 0);
    const window = offset + limit;

    // A search term matches the provider name or the owner's email, so owner
    // uids are resolved up front and folded into the provider query.
    let ownerUidsMatchingSearch: string[] | null = null;
    if (filter.search?.trim()) {
      const rx = new RegExp(escapeRegex(filter.search.trim()), 'i');
      const users = await this.userModel
        .find({ email: rx })
        .select('_id')
        .exec();
      ownerUidsMatchingSearch = users.map((u) => String(u._id));
    }

    const buildQuery = (nameField: string): Record<string, unknown> => {
      const q: Record<string, unknown> = {};
      if (filter.verificationStatus) {
        q.verificationStatus = filter.verificationStatus;
      }
      if (filter.search?.trim()) {
        const rx = new RegExp(escapeRegex(filter.search.trim()), 'i');
        q.$or = [
          { [nameField]: rx },
          { uid: { $in: ownerUidsMatchingSearch ?? [] } },
        ];
      }
      return q;
    };

    const wantBranches = filter.providerType !== KycProviderType.WASHER;
    const wantWashers = filter.providerType !== KycProviderType.MERCHANT_BRANCH;

    const branchQuery = buildQuery('branchName');
    const washerQuery = buildQuery('displayName');

    // Every washer registration also creates a Branch row (see
    // UsersService.createWasherShopAnchor) purely as a foreign-key shim for the
    // shared Inventory/Product schema — she is not a laundromat. Without this
    // exclusion each washer surfaced TWICE in the admin queue: once correctly as
    // WASHER, and once as a phantom "Doc verification (Laundromat)" for her
    // anchor, which no reviewer can ever complete because no KYC document is
    // ever filed against it.
    //
    // The exclusion goes INTO the query rather than filtering the results,
    // because branchTotal drives pagination — post-filtering would fix the page
    // and leave the count inflated. Same reasoning as
    // BookingAvailabilityService.listProviders, which solved this once already.
    if (wantBranches) {
      const anchorIds = await this.washerAnchorBranchIds();
      if (anchorIds.length > 0) {
        branchQuery._id = { $nin: anchorIds };
      }
    }

    const [branches, branchTotal, washers, washerTotal] = await Promise.all([
      wantBranches
        ? this.branchModel
            .find(branchQuery)
            .sort({ updatedAt: -1 })
            .limit(window)
            .exec()
        : [],
      wantBranches ? this.branchModel.countDocuments(branchQuery).exec() : 0,
      wantWashers
        ? this.washerProfileModel
            .find(washerQuery)
            .sort({ updatedAt: -1 })
            .limit(window)
            .exec()
        : [],
      wantWashers
        ? this.washerProfileModel.countDocuments(washerQuery).exec()
        : 0,
    ]);

    type Candidate = {
      providerId: string;
      providerType: KycProviderType;
      providerName: string;
      ownerUid: string;
      verificationStatus: string;
      verifiedAt?: Date | null;
      rejectionReason?: string | null;
      verificationPolicyVersion?: number | null;
      sortKey: number;
    };

    const candidates: Candidate[] = [
      ...branches.map((b) => ({
        providerId: String(b._id),
        providerType: KycProviderType.MERCHANT_BRANCH,
        providerName: b.branchName,
        ownerUid: b.uid,
        verificationStatus: b.verificationStatus as string,
        verifiedAt: b.verifiedAt ?? null,
        rejectionReason: b.rejectionReason ?? null,
        verificationPolicyVersion: b.verificationPolicyVersion ?? null,
        sortKey:
          (b as unknown as { updatedAt?: Date }).updatedAt?.getTime() ?? 0,
      })),
      ...washers.map((w) => ({
        providerId: String(w._id),
        providerType: KycProviderType.WASHER,
        providerName: w.displayName,
        ownerUid: w.uid,
        verificationStatus: w.verificationStatus as string,
        verifiedAt: w.verifiedAt ?? null,
        rejectionReason: w.rejectionReason ?? null,
        verificationPolicyVersion: w.verificationPolicyVersion ?? null,
        sortKey:
          (w as unknown as { updatedAt?: Date }).updatedAt?.getTime() ?? 0,
      })),
    ]
      .sort((a, b) => b.sortKey - a.sortKey)
      .slice(offset, offset + limit);

    const data = await this.decorateProviderSummaries(candidates);
    return {
      data,
      total: branchTotal + washerTotal,
      limit,
      offset,
    };
  }

  /**
   * Attaches owner emails and per-provider document counts. Batched: two
   * queries for the whole page regardless of its size.
   */
  private async decorateProviderSummaries(
    candidates: Array<{
      providerId: string;
      providerType: KycProviderType;
      providerName: string;
      ownerUid: string;
      verificationStatus: string;
      verifiedAt?: Date | null;
      rejectionReason?: string | null;
      verificationPolicyVersion?: number | null;
    }>,
  ): Promise<KycProviderSummary[]> {
    if (!candidates.length) return [];

    const providerIds = candidates.map((c) => c.providerId);
    const ownerUids = [...new Set(candidates.map((c) => c.ownerUid))];

    const docs = await this.kycDocumentModel
      .find({
        providerId: { $in: providerIds },
        status: { $ne: KycDocumentStatus.SUPERSEDED },
      })
      .exec();

    // Reviewers holding a case are resolved in the same round trip as owners —
    // the queue shows "assigned to", and a bare uid is not an answer.
    const claimerUids = docs
      .map((d) => d.claimedByUid)
      .filter((uid): uid is string => !!uid);
    const users = await this.userModel
      .find({
        _id: { $in: [...new Set([...ownerUids, ...claimerUids])] },
      } as any)
      .select('email')
      .exec();

    const emails = new Map(users.map((u) => [String(u._id), u.email]));
    const byProvider = new Map<string, KycDocument[]>();
    for (const doc of docs) {
      const list = byProvider.get(doc.providerId) ?? [];
      list.push(doc);
      byProvider.set(doc.providerId, list);
    }

    return candidates.map((c) => {
      const live = byProvider.get(c.providerId) ?? [];
      const required = requiredKycDocumentTypes(
        c.providerType,
        this.claimedGovernmentIdType(live),
      );
      // Counts are over the REQUIRED set only — a retired type still sitting in
      // the queue must not make a provider look further along than it is.
      const relevant = live.filter((d) => required.includes(d.documentType));

      const submittedAts = live
        .map((d) => d.submittedAt?.getTime())
        .filter((t): t is number => !!t);
      const reviewedAts = live
        .map((d) => d.reviewedAt?.getTime())
        .filter((t): t is number => !!t);

      return {
        providerId: c.providerId,
        providerType: c.providerType,
        providerName: c.providerName,
        ownerUid: c.ownerUid,
        ownerEmail: emails.get(c.ownerUid) ?? null,
        verificationStatus: c.verificationStatus,
        verifiedAt: c.verifiedAt ?? null,
        rejectionReason: c.rejectionReason ?? null,
        requiredCount: required.length,
        approvedCount: relevant.filter((d) => this.satisfiesRequirement(d))
          .length,
        pendingCount: relevant.filter((d) =>
          REVIEWABLE_STATUSES.includes(d.status),
        ).length,
        rejectedCount: relevant.filter(
          (d) => d.status === KycDocumentStatus.REJECTED,
        ).length,
        // Case-level assignment: claiming is all-or-nothing per provider, so any
        // held document identifies the holder of the whole case.
        claimedByUid: live.find((d) => d.claimedByUid)?.claimedByUid ?? null,
        claimedByEmail:
          emails.get(live.find((d) => d.claimedByUid)?.claimedByUid ?? '') ??
          null,
        verificationPolicyVersion: c.verificationPolicyVersion ?? null,
        // An APPROVED provider carrying no stamp, or one older than the current
        // edition, was verified under superseded rules. Anything not APPROVED
        // is simply in progress — never "legacy".
        grandfathered:
          c.verificationStatus === 'APPROVED' &&
          (c.verificationPolicyVersion ?? 0) < KYC_POLICY_VERSION,
        lastSubmittedAt: submittedAts.length
          ? new Date(Math.max(...submittedAts))
          : null,
        lastDecisionAt: reviewedAts.length
          ? new Date(Math.max(...reviewedAts))
          : null,
      };
    });
  }

  /**
   * Full record for one provider: every document ever submitted (including
   * SUPERSEDED history), what is still missing, and the provider's audit trail.
   * Admin/support only — ownership is not checked because the caller is already
   * role-gated at the resolver.
   */
  async providerDetail(
    providerType: KycProviderType,
    providerId: string,
  ): Promise<KycProviderDetail> {
    const summaryPage = await this.decorateProviderSummaries([
      await this.loadProviderIdentity(providerType, providerId),
    ]);
    const summary = summaryPage[0];

    const [docs, auditEvents] = await Promise.all([
      this.kycDocumentModel
        .find({ providerId })
        .sort({ submittedAt: -1 })
        .exec(),
      this.auditModel
        .find({ providerId })
        .sort({ timestamp: -1 })
        .limit(200)
        .exec(),
    ]);

    const reviewerUids = [
      ...new Set(
        docs
          .flatMap((d) => [d.reviewedByUid, d.claimedByUid])
          .filter((uid): uid is string => !!uid),
      ),
    ];
    const reviewers = reviewerUids.length
      ? await this.userModel
          .find({ _id: { $in: reviewerUids } } as any)
          .select('email')
          .exec()
      : [];
    const reviewerEmails = new Map(
      reviewers.map((u) => [String(u._id), u.email]),
    );

    const required = requiredKycDocumentTypes(
      providerType,
      this.claimedGovernmentIdType(docs),
    );
    const now = Date.now();

    const documents: KycProviderDocumentView[] = docs.map((document) => ({
      document,
      required: required.includes(document.documentType),
      reviewedByEmail: document.reviewedByUid
        ? (reviewerEmails.get(document.reviewedByUid) ?? null)
        : null,
      claimedByEmail: document.claimedByUid
        ? (reviewerEmails.get(document.claimedByUid) ?? null)
        : null,
      expired: !!document.expiresAt && document.expiresAt.getTime() <= now,
    }));

    // "Missing" means no LIVE document of that type — a superseded one does not
    // count, since it no longer represents the provider's submission.
    const liveTypes = new Set(
      docs
        .filter((d) => d.status !== KycDocumentStatus.SUPERSEDED)
        .map((d) => d.documentType),
    );

    return {
      summary,
      documents,
      missingDocumentTypes: required.filter((t) => !liveTypes.has(t)),
      auditTrail: await this.decorateAuditEvents(auditEvents),
    };
  }

  /** Provider identity without the ownership check resolveOwnedProvider does. */
  private async loadProviderIdentity(
    providerType: KycProviderType,
    providerId: string,
  ): Promise<{
    providerId: string;
    providerType: KycProviderType;
    providerName: string;
    ownerUid: string;
    verificationStatus: string;
    verifiedAt?: Date | null;
    rejectionReason?: string | null;
    // Must be carried: decorateProviderSummaries reads this, and a missing
    // value reads as null — which then marks a provider verified under the
    // CURRENT policy as grandfathered. The list path mapped it and the detail
    // path did not, so the same provider disagreed with itself.
    verificationPolicyVersion?: number | null;
  }> {
    if (providerType === KycProviderType.MERCHANT_BRANCH) {
      const branch = await this.branchModel.findById(providerId).exec();
      if (!branch) throw new NotFoundException('Branch not found');
      return {
        providerId: String(branch._id),
        providerType,
        providerName: branch.branchName,
        ownerUid: branch.uid,
        verificationStatus: branch.verificationStatus,
        verifiedAt: branch.verifiedAt ?? null,
        rejectionReason: branch.rejectionReason ?? null,
        verificationPolicyVersion: branch.verificationPolicyVersion ?? null,
      };
    }
    const profile = await this.washerProfileModel.findById(providerId).exec();
    if (!profile) throw new NotFoundException('Washer profile not found');
    return {
      providerId: String(profile._id),
      providerType,
      providerName: profile.displayName,
      ownerUid: profile.uid,
      verificationStatus: profile.verificationStatus,
      verifiedAt: profile.verifiedAt ?? null,
      rejectionReason: profile.rejectionReason ?? null,
      verificationPolicyVersion: profile.verificationPolicyVersion ?? null,
    };
  }

  /**
   * Platform-wide KYC audit feed. The collection remains append-only — this is
   * a read path only, and no write/update/delete counterpart may be added.
   */
  async auditLog(
    filter: KycAuditFilterInput = {},
  ): Promise<PaginatedKycAuditEvents> {
    const limit = Math.min(
      Math.max(filter.limit ?? 25, 1),
      MAX_REVIEW_QUEUE_LIMIT,
    );
    const offset = Math.max(filter.offset ?? 0, 0);

    const query: Record<string, unknown> = {};
    if (filter.event) query.event = filter.event;
    if (filter.providerId) query.providerId = filter.providerId;
    if (filter.documentId) query.documentId = filter.documentId;
    if (filter.actorUid) query.actorUid = filter.actorUid;
    if (filter.dateFrom || filter.dateTo) {
      const range: Record<string, Date> = {};
      if (filter.dateFrom) range.$gte = filter.dateFrom;
      if (filter.dateTo) range.$lte = filter.dateTo;
      query.timestamp = range;
    }

    const [events, total] = await Promise.all([
      this.auditModel
        .find(query)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.auditModel.countDocuments(query).exec(),
    ]);

    return {
      data: await this.decorateAuditEvents(events),
      total,
      limit,
      offset,
    };
  }

  /** Resolves actor emails and provider names for a page of audit events. */
  private async decorateAuditEvents(
    events: KycAuditEvent[],
  ): Promise<KycAuditEventView[]> {
    if (!events.length) return [];

    const actorUids = [...new Set(events.map((e) => e.actorUid))];
    const branchIds = events
      .filter((e) => e.providerType === KycProviderType.MERCHANT_BRANCH)
      .map((e) => e.providerId);
    const washerIds = events
      .filter((e) => e.providerType === KycProviderType.WASHER)
      .map((e) => e.providerId);

    const [users, branches, washers] = await Promise.all([
      this.userModel
        .find({ _id: { $in: actorUids } } as any)
        .select('email')
        .exec(),
      branchIds.length
        ? this.branchModel
            .find({ _id: { $in: branchIds } } as any)
            .select('branchName')
            .exec()
        : [],
      washerIds.length
        ? this.washerProfileModel
            .find({ _id: { $in: washerIds } } as any)
            .select('displayName')
            .exec()
        : [],
    ]);

    const emails = new Map(users.map((u) => [String(u._id), u.email]));
    const names = new Map<string, string>();
    for (const b of branches) names.set(String(b._id), b.branchName);
    for (const w of washers) names.set(String(w._id), w.displayName);

    return events.map((e) => ({
      _id: String((e as unknown as { _id: unknown })._id),
      event: e.event,
      actorUid: e.actorUid,
      actorEmail: emails.get(e.actorUid) ?? null,
      documentId: e.documentId ?? null,
      providerId: e.providerId,
      providerType: e.providerType,
      providerName: names.get(e.providerId) ?? null,
      details: e.details ? JSON.stringify(e.details) : null,
      timestamp: e.timestamp ?? new Date(0),
    }));
  }

  /**
   * Dashboard KPIs. Queue/provider counts describe current standing and are
   * never date-filtered; decision throughput is measured over the requested
   * window (defaults to the last 30 days).
   */
  async metrics(dateFrom?: Date, dateTo?: Date): Promise<KycMetrics> {
    const to = dateTo ?? new Date();
    const from = dateFrom ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const decidedInWindow = {
      reviewedAt: { $gte: from, $lte: to },
    };

    // Washer anchor branches are excluded here for the same reason as in
    // providerSummaries: they are FK shims, not laundromats. Counting them
    // double-counted every washer and left the dashboard permanently showing
    // phantom pending laundromats that no reviewer could ever clear.
    const anchorBranchIds = await this.washerAnchorBranchIds();
    const realBranchFilter: Record<string, unknown> =
      anchorBranchIds.length > 0 ? { _id: { $nin: anchorBranchIds } } : {};

    // The two provider enums are separate TS types with identical members, so
    // the shared status string is narrowed per collection at the call.
    const providerStatusCounts = async (
      status: ProviderVerificationStatus,
    ): Promise<number> => {
      const [b, w] = await Promise.all([
        this.branchModel
          .countDocuments({
            ...realBranchFilter,
            verificationStatus: status as BranchVerificationStatus,
          })
          .exec(),
        this.washerProfileModel
          .countDocuments({
            verificationStatus: status as WasherVerificationStatus,
          })
          .exec(),
      ]);
      return b + w;
    };

    const [
      pendingReview,
      claimedForReview,
      providersPending,
      providersInReview,
      providersApproved,
      providersRejected,
      approvedInPeriod,
      rejectedInPeriod,
      oldestPending,
      durations,
    ] = await Promise.all([
      this.kycDocumentModel
        .countDocuments({ status: { $in: REVIEWABLE_STATUSES } })
        .exec(),
      this.kycDocumentModel
        .countDocuments({
          status: KycDocumentStatus.UNDER_REVIEW,
          claimedByUid: { $ne: null },
        })
        .exec(),
      providerStatusCounts('PENDING'),
      providerStatusCounts('IN_REVIEW'),
      providerStatusCounts('APPROVED'),
      providerStatusCounts('REJECTED'),
      this.kycDocumentModel
        .countDocuments({
          status: KycDocumentStatus.APPROVED,
          ...decidedInWindow,
        })
        .exec(),
      this.kycDocumentModel
        .countDocuments({
          status: KycDocumentStatus.REJECTED,
          ...decidedInWindow,
        })
        .exec(),
      this.kycDocumentModel
        .findOne({ status: { $in: REVIEWABLE_STATUSES } })
        .sort({ submittedAt: 1 })
        .select('submittedAt')
        .exec(),
      this.kycDocumentModel
        .aggregate<{ avgMs: number }>([
          {
            $match: {
              reviewedAt: { $gte: from, $lte: to },
              status: {
                $in: [KycDocumentStatus.APPROVED, KycDocumentStatus.REJECTED],
              },
            },
          },
          {
            $group: {
              _id: null,
              avgMs: {
                $avg: { $subtract: ['$reviewedAt', '$submittedAt'] },
              },
            },
          },
        ])
        .exec(),
    ]);

    const decided = approvedInPeriod + rejectedInPeriod;
    const avgMs = durations[0]?.avgMs;

    return {
      pendingReview,
      claimedForReview,
      providersPending,
      providersInReview,
      providersApproved,
      providersRejected,
      approvedInPeriod,
      rejectedInPeriod,
      // Null rather than 0 when nothing was decided — a 0 h turnaround would
      // read as "instant", which is the opposite of "no data".
      avgHoursToDecision:
        typeof avgMs === 'number' ? avgMs / (1000 * 60 * 60) : null,
      rejectionRate: decided ? rejectedInPeriod / decided : null,
      oldestPendingSubmittedAt: oldestPending?.submittedAt ?? null,
    };
  }

  // ------------------------------------------------------------------
  // Evidence access (signed URLs)
  // ------------------------------------------------------------------

  async getDocumentUrl(user: User, documentId: string): Promise<string> {
    const doc = await this.kycDocumentModel.findById(documentId).exec();
    if (!doc) throw new NotFoundException('KYC document not found');
    const provider = await this.loadProviderForDocument(doc);

    const reviewer = this.isReviewer(user);
    if (!reviewer && provider.ownerUid !== user._id) {
      throw new ForbiddenException(
        'You are not allowed to access this document.',
      );
    }

    const url = await this.storageProvider.getSignedReadUrl(
      doc.storageObjectKey,
      DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
    );
    await this.audit(
      KycAuditEventType.DOCUMENT_URL_ISSUED,
      user._id,
      provider,
      String(doc._id),
      {
        asReviewer: reviewer,
        expirySeconds: DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
      },
    );
    return url;
  }
}
