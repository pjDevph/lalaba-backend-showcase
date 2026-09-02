import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import {
  createPublicKey,
  createVerify,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { FirebaseService } from '../firebase/firebase.service';
import {
  BiometricCredential,
  BiometricCredentialDocument,
} from './schemas/biometric-credential.schema';
import { EnrollBiometricInput } from './dto/enroll-biometric.input';
import { BiometricChallenge } from './models/biometric-challenge.model';
import { BiometricSession } from './models/biometric-session.model';

// One-time challenges live only in the cache (matches how GqlAuthGuard/Devices
// stash short-lived auth artifacts) with a short TTL — never persisted.
const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const CHALLENGE_TTL_SECONDS = CHALLENGE_TTL_MS / 1000;

interface StoredChallenge {
  credentialId: string;
  challenge: string;
}

@Injectable()
export class BiometricService {
  private readonly logger = new Logger(BiometricService.name);

  constructor(
    @InjectModel(BiometricCredential.name)
    private readonly credentialModel: Model<BiometricCredentialDocument>,
    private readonly firebaseService: FirebaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private challengeKey(challengeId: string): string {
    return `biometric_challenge:${challengeId}`;
  }

  /**
   * Register (or re-register) this device's public key for the authenticated
   * user. Runs behind GqlAuthGuard, so `uid` is a verified Firebase identity —
   * a device can only ever enrol a key against the user currently signed in.
   */
  async enroll(
    uid: string,
    input: EnrollBiometricInput,
  ): Promise<BiometricCredential> {
    // Reject a garbage key early so we never store something unverifiable.
    this.assertValidPublicKey(input.publicKey);

    const credential = await this.credentialModel.findOneAndUpdate(
      { uid, deviceId: input.deviceId },
      {
        $set: {
          uid,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          platform: input.platform,
          publicKey: input.publicKey,
          algorithm: 'SHA256withRSA',
          disabled: false,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    this.logger.log(
      `Biometric credential enrolled — uid=${uid} device=${input.deviceId}`,
    );
    return credential;
  }

  /** List the calling user's enrolled devices (for a "manage devices" UI). */
  async listForUser(uid: string): Promise<BiometricCredential[]> {
    return this.credentialModel.find({ uid }).sort({ updatedAt: -1 }).exec();
  }

  /** Revoke one of the caller's own credentials. */
  async revoke(uid: string, credentialId: string): Promise<boolean> {
    const credential = await this.credentialModel.findById(credentialId);
    // Ownership check — a user may only revoke their own credential.
    if (!credential || credential.uid !== uid) {
      throw new NotFoundException('Biometric credential not found.');
    }
    await credential.deleteOne();
    this.logger.log(
      `Biometric credential revoked — uid=${uid} id=${credentialId}`,
    );
    return true;
  }

  /**
   * Issue a one-time challenge for the given credential. Public (pre-login).
   * We do NOT reveal whether the credential exists in a distinguishable way —
   * a missing/disabled credential simply yields a generic rejection.
   */
  async requestChallenge(credentialId: string): Promise<BiometricChallenge> {
    const credential = await this.credentialModel.findById(credentialId);
    if (!credential || credential.disabled) {
      throw new UnauthorizedException('Biometric login is not available.');
    }

    const challenge = randomBytes(32).toString('base64');
    const challengeId = randomUUID();
    const stored: StoredChallenge = { credentialId, challenge };
    await this.cache.set(
      this.challengeKey(challengeId),
      stored,
      CHALLENGE_TTL_MS,
    );

    return { challengeId, challenge, expiresInSeconds: CHALLENGE_TTL_SECONDS };
  }

  /**
   * Verify the signed challenge and, on success, mint a Firebase custom token.
   * Public (pre-login) — the signature IS the proof of identity.
   */
  async login(
    credentialId: string,
    challengeId: string,
    signature: string,
  ): Promise<BiometricSession> {
    const key = this.challengeKey(challengeId);
    const stored = await this.cache.get<StoredChallenge>(key);

    // Consume the challenge immediately — single use, even on failure, so a
    // captured signature can never be replayed against the same nonce.
    await this.cache.del(key);

    if (!stored || stored.credentialId !== credentialId) {
      throw new UnauthorizedException(
        'Challenge expired or invalid. Try again.',
      );
    }

    const credential = await this.credentialModel.findById(credentialId);
    if (!credential || credential.disabled) {
      throw new UnauthorizedException('Biometric login is not available.');
    }

    const verified = this.verifySignature(
      credential.publicKey,
      stored.challenge,
      signature,
    );
    if (!verified) {
      this.logger.warn(
        `Biometric signature verification FAILED — id=${credentialId}`,
      );
      throw new UnauthorizedException('Biometric verification failed.');
    }

    // Confirm the Firebase account is still valid/enabled before minting.
    try {
      const fbUser = await this.firebaseService
        .getAuth()
        .getUser(credential.uid);
      if (fbUser.disabled) {
        throw new UnauthorizedException('This account has been disabled.');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Account is no longer available.');
    }

    credential.lastUsedAt = new Date();
    await credential.save();

    const customToken = await this.firebaseService
      .getAuth()
      .createCustomToken(credential.uid, { biometric: true });

    this.logger.log(`Biometric login OK — uid=${credential.uid}`);
    return { customToken };
  }

  // ── crypto helpers ─────────────────────────────────────────────────────────

  private toPem(base64Spki: string): string {
    const body =
      base64Spki
        .replace(/\s+/g, '')
        .match(/.{1,64}/g)
        ?.join('\n') ?? '';
    return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
  }

  private assertValidPublicKey(base64Spki: string): void {
    try {
      // Round-trips through OpenSSL; throws on a malformed/non-RSA key.
      const key = createPublicKey(this.toPem(base64Spki));
      if (key.asymmetricKeyType !== 'rsa') {
        throw new Error(`unexpected key type: ${key.asymmetricKeyType}`);
      }
    } catch {
      throw new UnauthorizedException('Invalid biometric public key.');
    }
  }

  private verifySignature(
    base64Spki: string,
    payload: string,
    signatureB64: string,
  ): boolean {
    try {
      const verifier = createVerify('SHA256');
      verifier.update(payload, 'utf8');
      verifier.end();
      return verifier.verify(this.toPem(base64Spki), signatureB64, 'base64');
    } catch (err) {
      this.logger.warn(`verifySignature error: ${(err as Error).message}`);
      return false;
    }
  }
}
