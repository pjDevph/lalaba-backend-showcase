import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { KycService } from './kyc.service';
import {
  KycDocument,
  KycDocumentStatus,
  KycProviderType,
  KycRejectionReason,
} from './schemas/kyc-document.schema';
import { SubmitKycDocumentInput } from './dto/submit-kyc-document.input';
import { MyKycStatus } from './models/kyc-status.model';
import { PaginatedKycReviewQueue } from './models/kyc-review-queue.model';
import {
  KycAuditFilterInput,
  KycMetrics,
  KycProviderDetail,
  KycProviderFilterInput,
  PaginatedKycAuditEvents,
  PaginatedKycProviderSummary,
  KycCaseDecisionInput,
} from './models/kyc-monitoring.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => KycDocument)
@UseGuards(GqlAuthGuard, RolesGuard)
export class KycResolver {
  constructor(private readonly kycService: KycService) {}

  // ─── Provider (merchant/washer) ──────────────────────────────────────

  @Mutation(() => KycDocument, {
    name: 'submitKycDocument',
    description:
      'Submit (or resubmit) one KYC document for a branch/washer profile the caller owns. The storage path is derived server-side; a resubmission supersedes the previous document of the same type.',
  })
  @Roles('merchant', 'washer')
  async submitKycDocument(
    @Args('input') input: SubmitKycDocumentInput,
    @CurrentUser() user: User,
  ): Promise<KycDocument> {
    return this.kycService.submitDocument(user, input);
  }

  @Query(() => MyKycStatus, {
    name: 'myKycStatus',
    description:
      'Per-document-type KYC status (plus rejection reasons) for a provider the caller owns. providerId is required for MERCHANT_BRANCH, derived for WASHER.',
  })
  @Roles('merchant', 'washer')
  async myKycStatus(
    @Args('providerType', { type: () => KycProviderType })
    providerType: KycProviderType,
    @Args('providerId', { type: () => ID, nullable: true })
    providerId: string | undefined,
    @CurrentUser() user: User,
  ): Promise<MyKycStatus> {
    return this.kycService.myKycStatus(user, providerType, providerId);
  }

  // ─── Admin / Support review ──────────────────────────────────────────

  @Query(() => PaginatedKycReviewQueue, {
    name: 'kycReviewQueue',
    description:
      'KYC documents awaiting review (SUBMITTED/UNDER_REVIEW), oldest first, with the provider name and owner email a reviewer needs. Pass claimed:true for documents a reviewer currently holds, claimed:false for unclaimed ones, omit for both. Pass status to widen the queue to already-decided documents.',
  })
  @Roles('admin', 'support')
  async kycReviewQueue(
    @Args('claimed', { type: () => Boolean, nullable: true })
    claimed?: boolean,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 25 })
    limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset?: number,
    @Args('status', { type: () => [KycDocumentStatus], nullable: true })
    status?: KycDocumentStatus[],
  ): Promise<PaginatedKycReviewQueue> {
    return this.kycService.reviewQueue(claimed, limit, offset, status);
  }

  @Mutation(() => KycProviderDetail, {
    name: 'claimKycCase',
    description:
      "Claim a provider's whole verification case — every document still reviewable — so one reviewer holds the entire identity. Idempotent for the holder; refused (naming the holder) if another reviewer has any part of it.",
  })
  @Roles('admin', 'support')
  async claimKycCase(
    @Args('providerType', { type: () => KycProviderType })
    providerType: KycProviderType,
    @Args('providerId', { type: () => ID }) providerId: string,
    @CurrentUser() user: User,
  ): Promise<KycProviderDetail> {
    return this.kycService.claimCaseForReview(user, providerType, providerId);
  }

  @Mutation(() => KycProviderDetail, {
    name: 'releaseKycCase',
    description:
      'Return a claimed case to the queue without deciding anything. Only releases documents this reviewer holds.',
  })
  @Roles('admin', 'support')
  async releaseKycCase(
    @Args('providerType', { type: () => KycProviderType })
    providerType: KycProviderType,
    @Args('providerId', { type: () => ID }) providerId: string,
    @CurrentUser() user: User,
  ): Promise<KycProviderDetail> {
    return this.kycService.releaseCase(user, providerType, providerId);
  }

  @Mutation(() => KycDocument, {
    name: 'claimKycDocumentForReview',
    description:
      'Claim a submitted KYC document for review (SUBMITTED → UNDER_REVIEW), recording the reviewer. Idempotent for the reviewer already holding it; refused if another reviewer holds it. Approve/reject remain possible over a stale claim (audited as an override).',
  })
  @Roles('admin', 'support')
  async claimKycDocumentForReview(
    @Args('documentId', { type: () => ID }) documentId: string,
    @CurrentUser() user: User,
  ): Promise<KycDocument> {
    return this.kycService.claimDocumentForReview(user, documentId);
  }

  @Mutation(() => KycDocument, {
    name: 'approveKycDocument',
    description:
      "Approve one KYC document. When all required document types for the provider are APPROVED, the provider's verificationStatus flips to APPROVED (badge only — never a marketplace/top-up gate).",
  })
  @Roles('admin', 'support')
  async approveKycDocument(
    @Args('documentId', { type: () => ID }) documentId: string,
    @CurrentUser() user: User,
  ): Promise<KycDocument> {
    return this.kycService.approveDocument(user, documentId);
  }

  @Mutation(() => KycDocument, {
    name: 'rejectKycDocument',
    description:
      "Reject one KYC document with a structured reason (plus an optional note appended to the provider-facing text). Sets the provider's verificationStatus to REJECTED; the provider may resubmit (the new document supersedes this one).",
  })
  @Roles('admin', 'support')
  async rejectKycDocument(
    @Args('documentId', { type: () => ID }) documentId: string,
    @Args('reason', { type: () => KycRejectionReason })
    reason: KycRejectionReason,
    // Explicit type: `string | null` emits no design:type metadata, so Nest
    // cannot infer the GraphQL type and the whole schema fails to build.
    @Args('note', { type: () => String, nullable: true }) note: string | null,
    @CurrentUser() user: User,
  ): Promise<KycDocument> {
    return this.kycService.rejectDocument(user, documentId, reason, note);
  }

  @Mutation(() => KycProviderDetail, {
    name: 'completeKycCaseReview',
    description:
      'Apply every decision for one case at once and notify the provider a single time with a consolidated result, instead of one push per document.',
  })
  @Roles('admin', 'support')
  async completeKycCaseReview(
    @Args('providerType', { type: () => KycProviderType })
    providerType: KycProviderType,
    @Args('providerId', { type: () => ID }) providerId: string,
    @Args('decisions', { type: () => [KycCaseDecisionInput] })
    decisions: KycCaseDecisionInput[],
    @CurrentUser() user: User,
  ): Promise<KycProviderDetail> {
    return this.kycService.completeCaseReview(
      user,
      providerType,
      providerId,
      decisions,
    );
  }

  // ─── Admin / Support monitoring ──────────────────────────────────────

  @Query(() => PaginatedKycProviderSummary, {
    name: 'kycProviders',
    description:
      'Per-provider KYC rollup: badge status plus approved/pending/rejected counts against the required document set. Includes providers that have not started (PENDING, 0/N). Most recently updated first.',
  })
  @Roles('admin', 'support')
  async kycProviders(
    @Args('filter', { type: () => KycProviderFilterInput, nullable: true })
    filter?: KycProviderFilterInput,
  ): Promise<PaginatedKycProviderSummary> {
    return this.kycService.providerSummaries(filter ?? {});
  }

  @Query(() => KycProviderDetail, {
    name: 'kycProviderDetail',
    description:
      "One provider's full KYC record: every document ever submitted (including superseded history), the required types still missing, and that provider's audit trail.",
  })
  @Roles('admin', 'support')
  async kycProviderDetail(
    @Args('providerType', { type: () => KycProviderType })
    providerType: KycProviderType,
    @Args('providerId', { type: () => ID }) providerId: string,
  ): Promise<KycProviderDetail> {
    return this.kycService.providerDetail(providerType, providerId);
  }

  @Query(() => PaginatedKycAuditEvents, {
    name: 'kycAuditLog',
    description:
      'Platform-wide KYC audit trail (submissions, claims, decisions, signed-URL issuance), newest first. Read-only view of an append-only collection.',
  })
  @Roles('admin', 'support')
  async kycAuditLog(
    @Args('filter', { type: () => KycAuditFilterInput, nullable: true })
    filter?: KycAuditFilterInput,
  ): Promise<PaginatedKycAuditEvents> {
    return this.kycService.auditLog(filter ?? {});
  }

  @Query(() => KycMetrics, {
    name: 'kycMetrics',
    description:
      'KYC dashboard KPIs. Queue and provider counts are current standing; approved/rejected/turnaround are measured over the requested window (default: last 30 days).',
  })
  @Roles('admin', 'support')
  async kycMetrics(
    @Args('dateFrom', { type: () => Date, nullable: true }) dateFrom?: Date,
    @Args('dateTo', { type: () => Date, nullable: true }) dateTo?: Date,
  ): Promise<KycMetrics> {
    return this.kycService.metrics(dateFrom, dateTo);
  }

  // ─── Evidence access ─────────────────────────────────────────────────

  @Query(() => String, {
    name: 'kycDocumentUrl',
    description:
      'Short-lived (300s) signed read URL for a KYC document. Only the owning provider or an admin/support reviewer may fetch; every issuance is written to the KYC audit trail.',
  })
  @Roles('merchant', 'washer', 'admin', 'support')
  async kycDocumentUrl(
    @Args('documentId', { type: () => ID }) documentId: string,
    @CurrentUser() user: User,
  ): Promise<string> {
    return this.kycService.getDocumentUrl(user, documentId);
  }
}
