import { InputType, Field, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType()
export class BiometricChallengeInput {
  // The credential _id returned at enrolment and persisted on the device.
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Field(() => ID)
  credentialId!: string;
}
