import { InputType, Field, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType()
export class BiometricLoginInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Field(() => ID)
  credentialId!: string;

  // Opaque id returned by requestBiometricChallenge, binds this attempt to the
  // one-time challenge stored server-side.
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Field()
  challengeId!: string;

  // Base64 SHA256withRSA signature over the challenge string.
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  @Field()
  signature!: string;
}
