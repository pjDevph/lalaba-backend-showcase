import { Field, ID, ObjectType } from '@nestjs/graphql';
import {
  GovernmentIdType,
  KycDocumentStatus,
  KycDocumentType,
  KycExpiryPolicy,
  KycProviderType,
} from '../schemas/kyc-document.schema';

// Per-document-type status for the provider's own verification screen. One
// entry per ALLOWED type (not just required ones), so a document retired from
// the required set still shows up for whoever already uploaded it.
// status is null while nothing has ever been submitted for the type.
@ObjectType()
export class KycDocumentTypeStatus {
  @Field(() => KycDocumentType)
  documentType!: KycDocumentType;

  // False for types retired from the required set. Optional rows are excluded
  // from the completion percentage and from the aggregate status.
  @Field(() => Boolean)
  required!: boolean;

  @Field(() => KycExpiryPolicy)
  expiryPolicy!: KycExpiryPolicy;

  @Field(() => KycDocumentStatus, { nullable: true })
  status?: KycDocumentStatus | null;

  @Field(() => ID, { nullable: true })
  documentId?: string | null;

  // Explicit types: a `T | null` union erases to Object at runtime, so Nest
  // cannot infer the GraphQL type and refuses to build the schema.
  @Field(() => Date, { nullable: true })
  submittedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  reviewedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date | null;

  @Field(() => String, { nullable: true })
  rejectionReason?: string | null;
}

@ObjectType()
export class MyKycStatus {
  @Field(() => ID)
  providerId!: string;

  @Field(() => KycProviderType)
  providerType!: KycProviderType;

  // Mirror of the provider's verificationStatus (PENDING/APPROVED/REJECTED)
  // — badge only, never a marketplace/discovery/top-up gate.
  @Field()
  verificationStatus!: string;

  @Field(() => Date, { nullable: true })
  verifiedAt?: Date | null;

  // Provider-level rejection reason. Kept separate from the per-document one:
  // once a rejected document is superseded by a resubmission its reason is no
  // longer reachable, and the app still needs something to show.
  @Field(() => String, { nullable: true })
  providerRejectionReason?: string | null;

  // The government ID the provider claimed on its latest front-of-ID upload,
  // or null before one exists. Returned so the app can preselect the picker on
  // a return visit, and so it agrees with the server about which documents the
  // `required` flags below were computed from.
  @Field(() => GovernmentIdType, { nullable: true })
  governmentIdType?: GovernmentIdType | null;

  @Field(() => [KycDocumentTypeStatus])
  documents!: KycDocumentTypeStatus[];
}
