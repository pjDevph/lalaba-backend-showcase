import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { KycProviderType } from './kyc-document.schema';

export type KycAuditEventDocument = KycAuditEvent & Document;

export enum KycAuditEventType {
  DOCUMENT_SUBMITTED = 'DOCUMENT_SUBMITTED',
  DOCUMENT_SUPERSEDED = 'DOCUMENT_SUPERSEDED',
  // A reviewer claimed the document (SUBMITTED → UNDER_REVIEW).
  DOCUMENT_CLAIMED_FOR_REVIEW = 'DOCUMENT_CLAIMED_FOR_REVIEW',
  // A different reviewer approved/rejected a document another reviewer had
  // claimed — recorded so the override is visible in the trail.
  DOCUMENT_CLAIM_OVERRIDDEN = 'DOCUMENT_CLAIM_OVERRIDDEN',
  // A reviewer took the whole provider case (every reviewable document at
  // once). The unit of review is the provider's identity, not one file, so
  // two reviewers must not end up holding halves of the same application.
  CASE_CLAIMED_FOR_REVIEW = 'CASE_CLAIMED_FOR_REVIEW',
  CASE_RELEASED = 'CASE_RELEASED',
  DOCUMENT_APPROVED = 'DOCUMENT_APPROVED',
  DOCUMENT_REJECTED = 'DOCUMENT_REJECTED',
  DOCUMENT_URL_ISSUED = 'DOCUMENT_URL_ISSUED',
  PROVIDER_VERIFICATION_APPROVED = 'PROVIDER_VERIFICATION_APPROVED',
  PROVIDER_VERIFICATION_REJECTED = 'PROVIDER_VERIFICATION_REJECTED',
}

// Append-only audit trail for the KYC lifecycle: KycService only ever
// create()s into this collection — no update or delete path exists, and
// none may be added. Internal/ops collection; not exposed over GraphQL.
@Schema({
  collection: 'kyc_audit_events',
  timestamps: { createdAt: 'timestamp', updatedAt: false },
})
export class KycAuditEvent {
  @Prop({ type: String, enum: KycAuditEventType, required: true })
  event!: KycAuditEventType;

  @Prop({ type: String, required: true })
  actorUid!: string;

  @Prop({ type: String, default: null })
  documentId?: string;

  @Prop({ type: String, required: true })
  providerId!: string;

  @Prop({ type: String, enum: KycProviderType, required: true })
  providerType!: KycProviderType;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  details?: Record<string, unknown>;

  timestamp?: Date;
}

export const KycAuditEventSchema = SchemaFactory.createForClass(KycAuditEvent);

KycAuditEventSchema.index({ providerId: 1, timestamp: -1 });
KycAuditEventSchema.index({ documentId: 1 });
