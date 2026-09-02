import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
// The washer SELFIE is captured by the same on-device liveness check couriers
// pass, so it records the same challenge and metadata. Imported rather than
// redeclared: `LivenessChallenge` and `LivenessMetadata` are GraphQL type NAMES
// and the registry is global — a second declaration would fail schema build.
import {
  LivenessChallenge,
  LivenessMetadata,
  LivenessMetadataSchema,
} from '../../courier-verification/schemas/courier-selfie.schema';

export type KycDocumentDocument = KycDocument & Document;

// Which kind of provider the document verifies. providerId is a Branch._id
// for MERCHANT_BRANCH and a WasherProfile._id for WASHER.
export enum KycProviderType {
  MERCHANT_BRANCH = 'MERCHANT_BRANCH',
  WASHER = 'WASHER',
}
registerEnumType(KycProviderType, { name: 'KycProviderType' });

// Members are persisted as strings — append only, never rename or remove.
export enum KycDocumentType {
  // Merchant branch
  BUSINESS_PERMIT = 'BUSINESS_PERMIT', // legacy: still accepted, no longer required
  OWNER_VALID_ID = 'OWNER_VALID_ID',
  DTI_CERTIFICATE = 'DTI_CERTIFICATE',
  BIR_2303 = 'BIR_2303',
  // The storefront photo set. Three types rather than one multi-file type:
  // the one-live-document-per-type invariant is what makes supersession and
  // the all-approved check work, and a reviewer needs to reject "the machines
  // photo is blurry" without invalidating the other two. The apps group these
  // back into a single "Business Photos" card.
  BUSINESS_PHOTO_STOREFRONT = 'BUSINESS_PHOTO_STOREFRONT',
  BUSINESS_PHOTO_INTERIOR = 'BUSINESS_PHOTO_INTERIOR',
  BUSINESS_PHOTO_MACHINES = 'BUSINESS_PHOTO_MACHINES',
  // Washer
  VALID_ID = 'VALID_ID', // front of the government ID
  VALID_ID_BACK = 'VALID_ID_BACK',
  BARANGAY_CLEARANCE = 'BARANGAY_CLEARANCE',
  PROOF_OF_ADDRESS = 'PROOF_OF_ADDRESS',
  SELFIE = 'SELFIE',
}
registerEnumType(KycDocumentType, { name: 'KycDocumentType' });

// Human-readable names, for surfaces that render a document type outside the
// apps' own copy — push notification bodies and the admin audit trail. The
// partner apps keep their own richer labels (with hints and grouping); this is
// deliberately the plain server-side name, not a second source of truth for
// the apps' UI.
export const KYC_DOCUMENT_LABELS: Record<KycDocumentType, string> = {
  [KycDocumentType.BUSINESS_PERMIT]: 'Business permit',
  [KycDocumentType.OWNER_VALID_ID]: "Owner's valid ID",
  [KycDocumentType.DTI_CERTIFICATE]: 'DTI certificate',
  [KycDocumentType.BIR_2303]: 'BIR Form 2303',
  [KycDocumentType.BUSINESS_PHOTO_STOREFRONT]: 'Storefront photo',
  [KycDocumentType.BUSINESS_PHOTO_INTERIOR]: 'Interior photo',
  [KycDocumentType.BUSINESS_PHOTO_MACHINES]: 'Machines photo',
  [KycDocumentType.VALID_ID]: 'Valid ID (front)',
  [KycDocumentType.VALID_ID_BACK]: 'Valid ID (back)',
  [KycDocumentType.BARANGAY_CLEARANCE]: 'Barangay clearance',
  [KycDocumentType.PROOF_OF_ADDRESS]: 'Proof of address',
  [KycDocumentType.SELFIE]: 'Selfie',
};

// Which kind of government-issued ID a provider claims to have submitted.
// Recorded so a reviewer compares the photo against a declared type instead of
// guessing at one, and so single-sided IDs can skip the back-of-ID upload.
//
// Members are persisted as strings — append only, never rename or remove.
export enum GovernmentIdType {
  PHILSYS_NATIONAL_ID = 'PHILSYS_NATIONAL_ID',
  DRIVERS_LICENSE = 'DRIVERS_LICENSE',
  PASSPORT = 'PASSPORT',
  UMID = 'UMID',
  SSS_ID = 'SSS_ID',
  PHILHEALTH_ID = 'PHILHEALTH_ID',
  POSTAL_ID = 'POSTAL_ID',
  VOTERS_ID = 'VOTERS_ID',
  PRC_ID = 'PRC_ID',
  TIN_ID = 'TIN_ID',
  // Escape hatch for a valid government ID outside the list above. Deliberately
  // NOT treated as single-sided: we cannot know, and asking for a back that
  // doesn't exist is recoverable where approving a half-seen ID is not.
  OTHER = 'OTHER',
}
registerEnumType(GovernmentIdType, { name: 'GovernmentIdType' });

// Plain server-side names, same role as KYC_DOCUMENT_LABELS: push bodies and
// the admin audit trail. The apps keep their own partner-facing copy.
export const GOVERNMENT_ID_LABELS: Record<GovernmentIdType, string> = {
  [GovernmentIdType.PHILSYS_NATIONAL_ID]: 'PhilSys National ID',
  [GovernmentIdType.DRIVERS_LICENSE]: "Driver's License",
  [GovernmentIdType.PASSPORT]: 'Passport',
  [GovernmentIdType.UMID]: 'UMID',
  [GovernmentIdType.SSS_ID]: 'SSS ID',
  [GovernmentIdType.PHILHEALTH_ID]: 'PhilHealth ID',
  [GovernmentIdType.POSTAL_ID]: 'Postal ID',
  [GovernmentIdType.VOTERS_ID]: "Voter's ID",
  [GovernmentIdType.PRC_ID]: 'PRC ID',
  [GovernmentIdType.TIN_ID]: 'TIN ID',
  [GovernmentIdType.OTHER]: 'Other government-issued ID',
};

/**
 * IDs with nothing on the reverse. A passport is a booklet whose data page is
 * the whole document, so requiring VALID_ID_BACK of a passport holder is a
 * requirement they can never satisfy.
 *
 * Everything absent from this set — OTHER included — is treated as two-sided.
 */
export const SINGLE_SIDED_GOVERNMENT_ID_TYPES: ReadonlySet<GovernmentIdType> =
  new Set([GovernmentIdType.PASSPORT]);

/**
 * The front-of-ID document types, i.e. the ones that carry a governmentIdType.
 *
 * Only the front does: front and back are separate documents, and storing the
 * claimed type on both invites the two to disagree. The back inherits its
 * meaning from the front.
 */
export const GOVERNMENT_ID_DOCUMENT_TYPES: readonly KycDocumentType[] = [
  KycDocumentType.VALID_ID,
  KycDocumentType.OWNER_VALID_ID,
];

// Whether a document type carries a meaningful expiry date, and whether the
// submitter must supply one. Drives both server-side validation and the
// apps' conditional expiry input.
export enum KycExpiryPolicy {
  NONE = 'NONE',
  OPTIONAL = 'OPTIONAL',
  REQUIRED = 'REQUIRED',
}
registerEnumType(KycExpiryPolicy, { name: 'KycExpiryPolicy' });

export const KYC_DOCUMENT_EXPIRY_POLICY: Record<
  KycDocumentType,
  KycExpiryPolicy
> = {
  [KycDocumentType.BUSINESS_PERMIT]: KycExpiryPolicy.REQUIRED,
  [KycDocumentType.BARANGAY_CLEARANCE]: KycExpiryPolicy.REQUIRED,
  [KycDocumentType.OWNER_VALID_ID]: KycExpiryPolicy.OPTIONAL,
  [KycDocumentType.VALID_ID]: KycExpiryPolicy.OPTIONAL,
  [KycDocumentType.VALID_ID_BACK]: KycExpiryPolicy.OPTIONAL,
  [KycDocumentType.PROOF_OF_ADDRESS]: KycExpiryPolicy.OPTIONAL,
  // Permanent registrations and photos never expire.
  [KycDocumentType.DTI_CERTIFICATE]: KycExpiryPolicy.NONE,
  [KycDocumentType.BIR_2303]: KycExpiryPolicy.NONE,
  [KycDocumentType.BUSINESS_PHOTO_STOREFRONT]: KycExpiryPolicy.NONE,
  [KycDocumentType.BUSINESS_PHOTO_INTERIOR]: KycExpiryPolicy.NONE,
  [KycDocumentType.BUSINESS_PHOTO_MACHINES]: KycExpiryPolicy.NONE,
  [KycDocumentType.SELFIE]: KycExpiryPolicy.NONE,
};

/**
 * Why a reviewer turned a document down. Structured so the provider gets
 * consistent, actionable copy instead of whatever the reviewer typed, and so
 * "what do we reject most?" is answerable later without parsing free text.
 */
export enum KycRejectionReason {
  BLURRY = 'BLURRY',
  WRONG_DOCUMENT = 'WRONG_DOCUMENT',
  INCOMPLETE = 'INCOMPLETE',
  DETAILS_MISMATCH = 'DETAILS_MISMATCH',
  EXPIRED = 'EXPIRED',
  OBSCURED = 'OBSCURED',
  OTHER = 'OTHER',
}
registerEnumType(KycRejectionReason, { name: 'KycRejectionReason' });

/** Provider-facing copy per reason. The partner app renders this verbatim. */
export const KYC_REJECTION_REASON_TEXT: Record<KycRejectionReason, string> = {
  [KycRejectionReason.BLURRY]:
    'The image is too blurry to read. Please upload a clearer photo.',
  [KycRejectionReason.WRONG_DOCUMENT]:
    'This is not the document we asked for. Please upload the correct one.',
  [KycRejectionReason.INCOMPLETE]:
    'The document is incomplete — part of it is missing or cut off.',
  [KycRejectionReason.DETAILS_MISMATCH]:
    'The details do not match your profile. Please check and re-upload.',
  [KycRejectionReason.EXPIRED]:
    'This document has expired. Please upload a current one.',
  [KycRejectionReason.OBSCURED]:
    'Required details are covered or unreadable. Please upload a full, unobstructed photo.',
  [KycRejectionReason.OTHER]: 'This document needs to be replaced.',
};

export enum KycDocumentStatus {
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  // A newer document of the same type replaced this one (resubmission).
  SUPERSEDED = 'SUPERSEDED',
}
registerEnumType(KycDocumentStatus, { name: 'KycDocumentStatus' });

// The full document set a provider must have APPROVED (and unexpired) before
// its verificationStatus flips to APPROVED. Canonical rule: verificationStatus
// only drives the Verified/Unverified badge — it does NOT gate marketplace
// visibility, discovery, or wallet top-up.
//
// Deliberately SEPARATE from the submission allowlist below. Merchants
// verified under the older set (BUSINESS_PERMIT + OWNER_VALID_ID) are
// grandfathered: they keep their badge, and nothing downgrades them for the
// documents added here. See scripts/migrations/audit-kyc-required-set.ts.
/**
 * Which edition of the required-document policy a provider was verified under.
 *
 * Bump this whenever REQUIRED_KYC_DOCUMENT_TYPES gains or loses a type. It is
 * STAMPED on the provider at the moment it turns APPROVED, so "was this
 * verified under the old rules?" is a stored fact rather than something later
 * code has to infer from the document count — that inference is what makes a
 * legitimately grandfathered merchant read as "0 of 7 — Incomplete".
 *
 *   1 — original set (BUSINESS_PERMIT + OWNER_VALID_ID for merchants)
 *   2 — current set (DTI + BIR + three business photos; barangay clearance
 *       added for washers)
 */
export const KYC_POLICY_VERSION = 2;

/** Providers stamped below this were verified under a superseded policy. */
export const LEGACY_KYC_POLICY_VERSION = 1;

export const REQUIRED_KYC_DOCUMENT_TYPES: Record<
  KycProviderType,
  KycDocumentType[]
> = {
  [KycProviderType.MERCHANT_BRANCH]: [
    KycDocumentType.OWNER_VALID_ID,
    KycDocumentType.DTI_CERTIFICATE,
    KycDocumentType.BIR_2303,
    KycDocumentType.BUSINESS_PHOTO_STOREFRONT,
    KycDocumentType.BUSINESS_PHOTO_INTERIOR,
    KycDocumentType.BUSINESS_PHOTO_MACHINES,
  ],
  [KycProviderType.WASHER]: [
    KycDocumentType.VALID_ID,
    KycDocumentType.VALID_ID_BACK,
    KycDocumentType.SELFIE,
    KycDocumentType.PROOF_OF_ADDRESS,
    KycDocumentType.BARANGAY_CLEARANCE,
  ],
};

/**
 * The required set for a provider, given the kind of government ID it claimed.
 *
 * Use this rather than indexing REQUIRED_KYC_DOCUMENT_TYPES directly: the back
 * of the ID is only required when the ID has a back. Passing no type (nothing
 * submitted yet, or a type this build doesn't know) yields the full set, so the
 * checklist opens asking for both sides and only ever shrinks.
 *
 * The raw constant stays exported for the migration audit, which reasons about
 * the policy itself rather than about one provider.
 */
export function requiredKycDocumentTypes(
  providerType: KycProviderType,
  governmentIdType?: GovernmentIdType | null,
): KycDocumentType[] {
  const required = REQUIRED_KYC_DOCUMENT_TYPES[providerType];
  if (!governmentIdType) return [...required];
  if (!SINGLE_SIDED_GOVERNMENT_ID_TYPES.has(governmentIdType)) {
    return [...required];
  }
  return required.filter((type) => type !== KycDocumentType.VALID_ID_BACK);
}

// What a provider of each type may submit and a reviewer may act on — the
// required set plus anything retired from it. BUSINESS_PERMIT stays here so
// permits already in the review queue can still be approved, and so a merchant
// who uploaded one still sees it on their own screen (flagged required:false).
export const KYC_ALLOWED_DOCUMENT_TYPES: Record<
  KycProviderType,
  KycDocumentType[]
> = {
  [KycProviderType.MERCHANT_BRANCH]: [
    ...REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.MERCHANT_BRANCH],
    KycDocumentType.BUSINESS_PERMIT,
  ],
  [KycProviderType.WASHER]: [
    ...REQUIRED_KYC_DOCUMENT_TYPES[KycProviderType.WASHER],
  ],
};

@ObjectType()
@Schema({ collection: 'kyc_documents', timestamps: true })
export class KycDocument {
  @Field(() => ID)
  _id!: string;

  // Branch._id (MERCHANT_BRANCH) or WasherProfile._id (WASHER).
  @Field(() => ID)
  @Prop({ type: String, required: true })
  providerId!: string;

  @Field(() => KycProviderType)
  @Prop({ type: String, enum: KycProviderType, required: true })
  providerType!: KycProviderType;

  // Uid of the user who owns the provider and submitted the document —
  // denormalized so ownership checks don't need a provider lookup.
  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  ownerUid!: string;

  @Field(() => KycDocumentType)
  @Prop({ type: String, enum: KycDocumentType, required: true })
  documentType!: KycDocumentType;

  // Which government ID the provider says this is. Set only on the front-of-ID
  // types (GOVERNMENT_ID_DOCUMENT_TYPES) and null everywhere else — see the
  // note on that constant for why the back doesn't carry its own copy.
  //
  // Unlike the liveness fields this is not merely context: the required set is
  // derived from it, so a passport submission legitimately drops VALID_ID_BACK.
  @Field(() => GovernmentIdType, { nullable: true })
  @Prop({ type: String, enum: GovernmentIdType, default: null })
  governmentIdType?: GovernmentIdType | null;

  // Storage object key in the PRIVATE evidence store — never a public URL.
  // Deliberately not exposed over GraphQL; reads go through kycDocumentUrl,
  // which authorizes the caller and issues a short-lived signed URL.
  @Prop({ type: String, required: true })
  storageObjectKey!: string;

  @Field()
  @Prop({ type: String, required: true })
  mimeType!: string;

  @Field(() => Int)
  @Prop({ type: Number, required: true })
  fileSizeBytes!: number;

  @Field(() => KycDocumentStatus)
  @Prop({
    type: String,
    enum: KycDocumentStatus,
    default: KycDocumentStatus.SUBMITTED,
  })
  status!: KycDocumentStatus;

  @Field()
  @Prop({ type: Date, required: true })
  submittedAt!: Date;

  // When the document itself stops being valid (see KYC_DOCUMENT_EXPIRY_POLICY).
  // Null for types that never expire, and for OPTIONAL types the submitter
  // left blank. An expired document never satisfies a requirement, but nothing
  // downgrades an already-granted badge — expiry is derived for display.
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  reviewedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  reviewedByUid?: string;

  /**
   * Provider-facing rejection text. Kept as the composed string because the
   * partner app renders it verbatim in its Action Required card; the structured
   * code below is what analytics and the review UI read.
   */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  rejectionReason?: string;

  @Field(() => KycRejectionReason, { nullable: true })
  @Prop({ type: String, enum: KycRejectionReason, default: null })
  rejectionReasonCode?: KycRejectionReason | null;

  /** Reviewer's extra instruction, appended to the standard reason text. */
  // Explicit () => String: a `string | null` property emits no design:type,
  // so Nest cannot infer the GraphQL type and schema construction fails.
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  rejectionNote?: string | null;

  // Review claim (UNDER_REVIEW): which reviewer currently holds the document
  // and since when. Set by claimKycDocumentForReview, cleared when the
  // document leaves the queue (approve/reject). Null ⇒ unclaimed.
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  claimedByUid?: string;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  claimedAt?: Date;

  // Set on the NEW document when it replaces a previous submission of the
  // same type — points at the document it superseded.
  @Field(() => ID, { nullable: true })
  @Prop({ type: String, default: null })
  supersedesDocumentId?: string;

  // ── Liveness (SELFIE only) ───────────────────────────────────────────────
  // Present when the document was captured by the on-device liveness check
  // rather than a plain camera shot. Null on every other document type, and on
  // selfies submitted before that check existed.
  //
  // A CLIENT ASSERTION, exactly as it is for couriers: the server stores it for
  // the reviewer's context and can neither re-derive nor rely on it. Nothing in
  // the badge logic reads these fields.
  @Field(() => LivenessChallenge, { nullable: true })
  @Prop({ type: String, enum: LivenessChallenge, default: null })
  livenessChallenge?: LivenessChallenge | null;

  @Field(() => LivenessMetadata, { nullable: true })
  @Prop({ type: LivenessMetadataSchema, default: null })
  livenessMetadata?: LivenessMetadata | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const KycDocumentSchema = SchemaFactory.createForClass(KycDocument);

KycDocumentSchema.index({ providerId: 1, documentType: 1, status: 1 });
KycDocumentSchema.index({ status: 1, submittedAt: 1 });
KycDocumentSchema.index({ ownerUid: 1 });
// Review-queue "claimed vs unclaimed" filter (additive, sparse-friendly).
KycDocumentSchema.index({ status: 1, claimedByUid: 1, submittedAt: 1 });
// Expiry sweeps over live approvals.
KycDocumentSchema.index({ status: 1, expiresAt: 1 });
