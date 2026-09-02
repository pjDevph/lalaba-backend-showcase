import { ObjectType, Field, ID, Int, Float, InputType } from '@nestjs/graphql';
// ValidationPipe runs with `whitelist: true`, which DELETES any input property
// that carries no class-validator decorator. Without these the filter fields
// below are silently stripped before the resolver sees them — the query then
// returns every provider and the admin's filter appears to do nothing.
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  KycDocument,
  KycProviderType,
  KycRejectionReason,
} from '../schemas/kyc-document.schema';
import { KycAuditEventType } from '../schemas/kyc-audit-event.schema';
import { registerEnumType } from '@nestjs/graphql';

// The audit trail was previously an internal-only collection. It stays
// append-only and write-only from KycService; these types add a READ path for
// admin/support, nothing more.
registerEnumType(KycAuditEventType, { name: 'KycAuditEventType' });

@ObjectType()
export class KycAuditEventView {
  @Field(() => ID) _id!: string;

  @Field(() => KycAuditEventType) event!: KycAuditEventType;

  @Field() actorUid!: string;

  // Resolved at read time, like KycReviewQueueItem.ownerEmail — a bare uid is
  // useless in an audit UI. Null if the actor's account was deleted.
  @Field(() => String, { nullable: true }) actorEmail?: string | null;

  @Field(() => ID, { nullable: true }) documentId?: string | null;

  @Field(() => ID) providerId!: string;

  @Field(() => KycProviderType) providerType!: KycProviderType;

  @Field(() => String, { nullable: true }) providerName?: string | null;

  // Free-form event payload (rejection reason, superseded-by id, expiry
  // seconds…). Serialized rather than typed because the shape varies per event
  // and the admin UI renders it as key/value text.
  @Field(() => String, { nullable: true }) details?: string | null;

  @Field() timestamp!: Date;
}

@ObjectType()
export class PaginatedKycAuditEvents {
  @Field(() => [KycAuditEventView]) data!: KycAuditEventView[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}

@InputType()
export class KycAuditFilterInput {
  // Same whitelist rule as KycProviderFilterInput — undecorated properties are
  // stripped before the resolver runs, so the audit filters would no-op too.
  @Field(() => KycAuditEventType, { nullable: true })
  @IsOptional()
  @IsEnum(KycAuditEventType)
  event?: KycAuditEventType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  providerId?: string;
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  documentId?: string;
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  actorUid?: string;
  @Field(() => Date, { nullable: true }) @IsOptional() dateFrom?: Date;
  @Field(() => Date, { nullable: true }) @IsOptional() dateTo?: Date;
  @Field(() => Int, { nullable: true, defaultValue: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

// One row per provider rather than per document — the review queue answers
// "what should I work on next", this answers "where does this partner stand".
@ObjectType()
export class KycProviderSummary {
  @Field(() => ID) providerId!: string;
  @Field(() => KycProviderType) providerType!: KycProviderType;
  @Field(() => String, { nullable: true }) providerName?: string | null;
  @Field(() => String, { nullable: true }) ownerEmail?: string | null;
  @Field() ownerUid!: string;

  // The provider-level badge: PENDING | IN_REVIEW | APPROVED | REJECTED.
  // Typed as String, matching MyKycStatus.verificationStatus, because the two
  // provider entities carry separate (but identical) enums.
  @Field() verificationStatus!: string;

  @Field(() => Date, { nullable: true }) verifiedAt?: Date | null;
  @Field(() => String, { nullable: true }) rejectionReason?: string | null;

  // Counts over the REQUIRED set only, against live (non-superseded)
  // documents. requiredCount is the denominator the admin table renders as
  // "approvedCount / requiredCount".
  @Field(() => Int) requiredCount!: number;
  @Field(() => Int) approvedCount!: number;
  @Field(() => Int) pendingCount!: number;
  @Field(() => Int) rejectedCount!: number;

  @Field(() => Date, { nullable: true }) lastSubmittedAt?: Date | null;
  @Field(() => Date, { nullable: true }) lastDecisionAt?: Date | null;

  /**
   * Reviewer currently holding this case, if any. Assignment is per CASE, not
   * per document — see KycService.claimCaseForReview.
   */
  @Field(() => String, { nullable: true }) claimedByUid?: string | null;
  @Field(() => String, { nullable: true }) claimedByEmail?: string | null;

  /** KYC policy edition this provider was verified under. Null if never approved. */
  @Field(() => Int, { nullable: true })
  verificationPolicyVersion?: number | null;

  /**
   * APPROVED under a superseded policy. Their badge stands and nothing
   * downgrades them, but `approvedCount / requiredCount` is NOT comparable —
   * a grandfathered merchant legitimately shows 0 of 6. The UI must say
   * "Verified · legacy policy" instead of "0 of 6 — Incomplete".
   */
  @Field() grandfathered!: boolean;
}

@ObjectType()
export class PaginatedKycProviderSummary {
  @Field(() => [KycProviderSummary]) data!: KycProviderSummary[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}

@InputType()
export class KycProviderFilterInput {
  @Field(() => KycProviderType, { nullable: true })
  @IsOptional()
  @IsEnum(KycProviderType)
  providerType?: KycProviderType;

  // PENDING | IN_REVIEW | APPROVED | REJECTED. String for the same reason as
  // KycProviderSummary.verificationStatus.
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  verificationStatus?: string;

  // Matches provider name or owner email, case-insensitive.
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => Int, { nullable: true, defaultValue: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

// A document row in the provider detail view. Unlike MyKycStatus's rows this
// includes SUPERSEDED history and the reviewer's identity — an admin auditing
// a decision needs to see who made it and what it replaced.
@ObjectType()
export class KycProviderDocumentView {
  @Field(() => KycDocument) document!: KycDocument;
  @Field() required!: boolean;
  @Field(() => String, { nullable: true }) reviewedByEmail?: string | null;
  @Field(() => String, { nullable: true }) claimedByEmail?: string | null;
  // True when expiresAt is in the past — derived here so every surface agrees
  // on the cutoff instead of each one comparing clocks.
  @Field() expired!: boolean;
}

@ObjectType()
export class KycProviderDetail {
  @Field(() => KycProviderSummary) summary!: KycProviderSummary;

  // Every document ever submitted for this provider, newest first, including
  // superseded ones.
  @Field(() => [KycProviderDocumentView]) documents!: KycProviderDocumentView[];

  // Required types with nothing submitted yet — the gap the provider still has
  // to close. Present as strings for the same enum-neutrality reason above.
  @Field(() => [String]) missingDocumentTypes!: string[];

  @Field(() => [KycAuditEventView]) auditTrail!: KycAuditEventView[];
}

/** One reviewer decision inside a whole-case review. */
@InputType()
export class KycCaseDecisionInput {
  @Field(() => ID) @IsString() documentId!: string;

  @Field() @IsBoolean() approve!: boolean;

  // Required when approve is false; ignored otherwise.
  @Field(() => KycRejectionReason, { nullable: true })
  @IsOptional()
  @IsEnum(KycRejectionReason)
  reasonCode?: KycRejectionReason | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  note?: string | null;
}

@ObjectType()
export class KycMetrics {
  // Documents a reviewer could act on right now.
  @Field(() => Int) pendingReview!: number;
  @Field(() => Int) claimedForReview!: number;

  // Provider-level rollup across the whole platform (not date-filtered — these
  // describe current standing, not activity in a window).
  @Field(() => Int) providersPending!: number;
  @Field(() => Int) providersInReview!: number;
  @Field(() => Int) providersApproved!: number;
  @Field(() => Int) providersRejected!: number;

  // Decision activity inside the requested window.
  @Field(() => Int) approvedInPeriod!: number;
  @Field(() => Int) rejectedInPeriod!: number;

  // Mean submittedAt → reviewedAt over decisions in the window. Null when
  // nothing was decided, rather than a misleading 0.
  @Field(() => Float, { nullable: true }) avgHoursToDecision?: number | null;

  // rejected / (approved + rejected) in the window, 0–1. Null when nothing was
  // decided.
  @Field(() => Float, { nullable: true }) rejectionRate?: number | null;

  // Drives the "oldest thing waiting" tile — the number that tells an admin
  // whether the queue is being worked.
  @Field(() => Date, { nullable: true })
  oldestPendingSubmittedAt?: Date | null;
}
