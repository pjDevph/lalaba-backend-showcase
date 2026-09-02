import { Field, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { LivenessChallenge } from '../schemas/courier-selfie.schema';

// Mirrors LivenessMetadata on the schema. Every field is a client assertion the
// server cannot verify — bounds here reject nonsense, they do not establish
// truth. See the note on LivenessMetadata.
@InputType()
export class LivenessMetadataInput {
  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(600_000)
  durationMs!: number;

  @Field()
  @IsNumber()
  @Min(0)
  @Max(1)
  eyesOpenScore!: number;

  @Field()
  @IsNumber()
  @Min(-180)
  @Max(180)
  yawDegrees!: number;

  @Field()
  @IsNumber()
  @Min(-180)
  @Max(180)
  pitchDegrees!: number;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(1000)
  attemptCount!: number;
}

@InputType()
export class SubmitCourierSelfieInput {
  // Raw image content. The storage key is derived server-side — the caller
  // never chooses a folder, a key, or a URL. Accepting a URL instead would let
  // a client point their profile picture at any host, which is exactly the hole
  // every other *Url field in this codebase still has.
  @Field()
  @IsString()
  @IsNotEmpty()
  base64!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  mimeType!: string;

  @Field(() => LivenessChallenge)
  @IsEnum(LivenessChallenge)
  livenessChallenge!: LivenessChallenge;

  @Field(() => LivenessMetadataInput)
  @ValidateNested()
  @Type(() => LivenessMetadataInput)
  livenessMetadata!: LivenessMetadataInput;
}
