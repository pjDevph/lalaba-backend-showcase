import { Field, ID, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  GovernmentIdType,
  KycDocumentType,
  KycProviderType,
} from '../schemas/kyc-document.schema';
// Shared with the courier flow — same on-device check, same shape. See the note
// on the liveness fields in kyc-document.schema.ts.
import { LivenessChallenge } from '../../courier-verification/schemas/courier-selfie.schema';
import { LivenessMetadataInput } from '../../courier-verification/dto/submit-courier-selfie.input';

@InputType()
export class SubmitKycDocumentInput {
  @Field(() => KycProviderType)
  @IsEnum(KycProviderType)
  providerType!: KycProviderType;

  // Branch._id for MERCHANT_BRANCH (required — a merchant may own several
  // branches). Optional for WASHER: the profile is derived from the caller.
  // Ownership is verified server-side either way.
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  providerId?: string;

  @Field(() => KycDocumentType)
  @IsEnum(KycDocumentType)
  documentType!: KycDocumentType;

  // Raw file content. The storage path is derived server-side — the caller
  // never chooses a folder or key.
  @Field()
  @IsString()
  @IsNotEmpty()
  base64!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  mimeType!: string;

  // Which government ID this is. Required for the front-of-ID types and
  // rejected on every other type — enforced in KycService.submitDocument, where
  // the document type is known, exactly as the expiry policy is. Nullable here
  // so one input class still serves all twelve document types.
  @Field(() => GovernmentIdType, { nullable: true })
  @IsOptional()
  @IsEnum(GovernmentIdType)
  governmentIdType?: GovernmentIdType;

  // When the document stops being valid. Required for document types whose
  // KYC_DOCUMENT_EXPIRY_POLICY is REQUIRED, rejected if already past; ignored
  // for types that never expire.
  @Field(() => Date, { nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;

  // What the on-device liveness check asked for and what it observed. Sent only
  // for SELFIE, and stored verbatim for the reviewer — see the liveness fields
  // on KycDocument for why the server treats it as context, not evidence.
  // Optional so older clients (and every non-selfie upload) keep working.
  @Field(() => LivenessChallenge, { nullable: true })
  @IsOptional()
  @IsEnum(LivenessChallenge)
  livenessChallenge?: LivenessChallenge;

  @Field(() => LivenessMetadataInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LivenessMetadataInput)
  livenessMetadata?: LivenessMetadataInput;
}
