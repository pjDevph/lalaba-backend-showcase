import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { BiometricService } from './biometric.service';
import { BiometricCredential } from './schemas/biometric-credential.schema';
import { BiometricChallenge } from './models/biometric-challenge.model';
import { BiometricSession } from './models/biometric-session.model';
import { EnrollBiometricInput } from './dto/enroll-biometric.input';
import { BiometricChallengeInput } from './dto/biometric-challenge.input';
import { BiometricLoginInput } from './dto/biometric-login.input';
import { RequireAppCheck } from '../auth/decorators/require-app-check.decorator';
import { AppCheckGuard } from '../auth/guards/app-check.guard';

@Resolver(() => BiometricCredential)
export class BiometricResolver {
  constructor(private readonly biometricService: BiometricService) {}

  // ── Authenticated: enrol / manage this device ──────────────────────────────

  @Mutation(() => BiometricCredential)
  @UseGuards(GqlAuthGuard)
  async enrollBiometric(
    @Args('input') input: EnrollBiometricInput,
    @CurrentUser() user: User,
  ): Promise<BiometricCredential> {
    return this.biometricService.enroll(user._id, input);
  }

  @Query(() => [BiometricCredential], { name: 'myBiometricCredentials' })
  @UseGuards(GqlAuthGuard)
  async myBiometricCredentials(
    @CurrentUser() user: User,
  ): Promise<BiometricCredential[]> {
    return this.biometricService.listForUser(user._id);
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async revokeBiometric(
    @Args('credentialId', { type: () => ID }) credentialId: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.biometricService.revoke(user._id, credentialId);
  }

  // ── Public: pre-login challenge / verification ─────────────────────────────
  // No GqlAuthGuard — these run before a session exists. Identity is proven by
  // the signature over the one-time challenge, not by a bearer token.
  //
  // APPCHK-012/013: which is exactly why they carry @RequireAppCheck(). With
  // no session to rate-limit against and no user to hold accountable, the only
  // remaining question worth asking is "is this a genuine build of our app?".
  // These two were the entire unauthenticated custom-backend surface in the
  // B3 finding.

  @Mutation(() => BiometricChallenge)
  @RequireAppCheck()
  @UseGuards(AppCheckGuard)
  async requestBiometricChallenge(
    @Args('input') input: BiometricChallengeInput,
  ): Promise<BiometricChallenge> {
    return this.biometricService.requestChallenge(input.credentialId);
  }

  @Mutation(() => BiometricSession)
  @RequireAppCheck()
  @UseGuards(AppCheckGuard)
  async biometricLogin(
    @Args('input') input: BiometricLoginInput,
  ): Promise<BiometricSession> {
    return this.biometricService.login(
      input.credentialId,
      input.challengeId,
      input.signature,
    );
  }
}
