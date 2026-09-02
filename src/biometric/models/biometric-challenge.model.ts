import { ObjectType, Field } from '@nestjs/graphql';

/** Response of requestBiometricChallenge — the nonce the device must sign. */
@ObjectType()
export class BiometricChallenge {
  @Field()
  challengeId!: string;

  // Random one-time nonce (base64). The device signs exactly this string.
  @Field()
  challenge!: string;

  @Field()
  expiresInSeconds!: number;
}
