import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString } from 'class-validator';

// Certification evidence is uploaded as bytes, not as a caller-chosen public
// URL — the server derives the storage key and writes to the PRIVATE evidence
// store (RISK-P0-002). Same shape as SubmitKycDocumentInput's file half.
@InputType()
export class CertificationProofInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => String, {
    description:
      'Base64-encoded file contents (a data: URI prefix is accepted and stripped).',
  })
  base64!: string;

  @IsString()
  @IsNotEmpty()
  @Field(() => String, {
    description:
      'MIME type: image/jpeg, image/png, image/webp, image/heic, application/pdf, or .docx.',
  })
  mimeType!: string;
}
