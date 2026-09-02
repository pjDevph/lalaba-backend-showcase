import { ObjectType, Field } from '@nestjs/graphql';

/**
 * Response of biometricLogin — a Firebase custom token the client exchanges via
 * signInWithCustomToken() to obtain a real session.
 */
@ObjectType()
export class BiometricSession {
  @Field()
  customToken!: string;
}
