import {
  Injectable,
  Logger,
  Module,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as path from 'node:path';
import * as fs from 'node:fs';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // Credential sources, in priority order:
    //   1. FIREBASE_CREDENTIALS_JSON  — full JSON string (production: Render).
    //   2. The REAL service account file on disk (FIREBASE_CREDENTIALS_PATH_ONLINE),
    //      falling back to FIREBASE_CREDENTIALS_PATH if the online path is unset.
    //
    // We ALWAYS load the real service account, even in local mode. Auth still routes
    // to the Auth Emulator whenever FIREBASE_AUTH_EMULATOR_HOST is set (that switch is
    // independent of the credential — the emulator ignores it), so local login is
    // unaffected. But Cloud Messaging has NO emulator: admin.messaging() always talks
    // to real FCM and needs real credentials to sign its requests. Loading the real
    // key here lets push notifications send in BOTH local and online modes.
    const credentialsJson = this.configService.get<string>(
      'FIREBASE_CREDENTIALS_JSON',
    );
    const emulatorHost = (
      this.configService.get<string>('FIREBASE_AUTH_EMULATOR_HOST') ?? ''
    ).trim();
    const usingEmulator = emulatorHost.length > 0;

    const localPath = this.configService.get<string>(
      'FIREBASE_CREDENTIALS_PATH',
    );
    const onlinePath = this.configService.get<string>(
      'FIREBASE_CREDENTIALS_PATH_ONLINE',
    );
    const credentialsPath = onlinePath ?? localPath;

    let serviceAccount: object;
    if (credentialsJson) {
      serviceAccount = JSON.parse(credentialsJson);
    } else if (credentialsPath) {
      const resolvedPath = path.resolve(process.cwd(), credentialsPath);
      serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      console.log(
        `🔥 [Firebase] auth=${usingEmulator ? 'emulator(local)' : 'real(online)'}, messaging=real — credentials: ${credentialsPath}`,
      );
    } else {
      throw new Error(
        'Missing Firebase credentials: set FIREBASE_CREDENTIALS_JSON (production), ' +
          'or FIREBASE_CREDENTIALS_PATH (local/emulator) / FIREBASE_CREDENTIALS_PATH_ONLINE (online).',
      );
    }

    // Storage Emulator. Unlike Auth — which firebase-admin routes on its own
    // from FIREBASE_AUTH_EMULATOR_HOST — Cloud Storage is served by the bundled
    // @google-cloud/storage client, which only reads the STORAGE_EMULATOR_HOST
    // process env, and only at client construction. So it has to be exported
    // here, BEFORE initializeApp, or every upload silently goes to the real
    // bucket while the emulator sits empty.
    const storageEmulatorHost = (
      this.configService.get<string>('FIREBASE_STORAGE_EMULATOR_HOST') ?? ''
    ).trim();
    if (storageEmulatorHost) {
      process.env.STORAGE_EMULATOR_HOST = storageEmulatorHost.startsWith('http')
        ? storageEmulatorHost
        : `http://${storageEmulatorHost}`;
    }

    // Initialize the Admin SDK directly
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    const bucketName = this.configService.get<string>(
      'FIREBASE_STORAGE_BUCKET',
    );
    if (!bucketName) {
      throw new Error(
        'FIREBASE_STORAGE_BUCKET environment variable is not set. ' +
          'Set it to your Firebase Storage bucket name (e.g. "my-project.appspot.com").',
      );
    }

    console.log(
      `🔥 Firebase Admin SDK successfully initialized! storage=${
        storageEmulatorHost
          ? `emulator(${storageEmulatorHost})`
          : 'real(online)'
      }`,
    );
  }

  /**
   * The Storage Emulator's host:port when local storage is on, else null.
   *
   * The storage provider branches on this because the emulator can neither
   * verify signed URLs nor serve `https://storage.googleapis.com/...` links —
   * see FirebaseStorageProvider.
   */
  getStorageEmulatorHost(): string | null {
    const host = (
      this.configService.get<string>('FIREBASE_STORAGE_EMULATOR_HOST') ?? ''
    ).trim();
    return host.length > 0 ? host.replace(/^https?:\/\//, '') : null;
  }

  // This remains perfectly intact because admin.auth() reads the globally initialized app context automatically
  getAuth(): admin.auth.Auth {
    return admin.auth();
  }

  // Cloud Messaging (FCM). Uses the real service account (see onModuleInit) so it
  // sends in both local and online modes. There is no FCM emulator.
  /**
   * APPCHK-011 — App Check verifier.
   *
   * Reads off the same initialized app as getAuth(). Note there is no App
   * Check emulator: unlike Auth, this always talks to the real service, which
   * is why local development runs with enforcement off rather than pointed at
   * a fake.
   */
  getAppCheck(): admin.appCheck.AppCheck {
    return admin.appCheck();
  }

  getMessaging(): admin.messaging.Messaging {
    return admin.messaging();
  }

  // Returns a Storage bucket reference using the bucket name from env
  getStorageBucket() {
    const bucketName = this.configService.get<string>(
      'FIREBASE_STORAGE_BUCKET',
    );
    if (!bucketName) {
      throw new Error(
        'Missing FIREBASE_STORAGE_BUCKET in environment configuration',
      );
    }
    return admin.storage().bucket(bucketName);
  }

  /**
   * Triggers Firebase's built-in password reset email for the given address,
   * via the Identity Toolkit REST API so no external email service is needed.
   *
   * Routed at the EMULATOR when one is configured. Unlike admin.auth(), this is
   * a hand-rolled fetch, so it does not pick up FIREBASE_AUTH_EMULATOR_HOST on
   * its own — pointing it at the real host in local mode sends every invite to
   * the production project, where the account does not exist. It fails there,
   * and the new admin never gets a link.
   *
   * Throws rather than warns. The only credential the caller sets on a new
   * account is a random password nobody holds, so this email is the sole way in:
   * swallowing the failure reports success and leaves an account that can never
   * be signed into.
   */
  async sendPasswordResetEmail(email: string): Promise<void> {
    const apiKey = this.configService.get<string>('FIREBASE_WEB_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Password reset email is not configured. Set FIREBASE_WEB_API_KEY.',
      );
    }

    const emulatorHost = (
      this.configService.get<string>('FIREBASE_AUTH_EMULATOR_HOST') ?? ''
    )
      .trim()
      .replace(/^https?:\/\//, '');
    const base = emulatorHost
      ? `http://${emulatorHost}/identitytoolkit.googleapis.com`
      : 'https://identitytoolkit.googleapis.com';

    let res: Response;
    try {
      res = await fetch(`${base}/v1/accounts:sendOobCode?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
      });
    } catch (err) {
      this.logger.error(
        `sendPasswordResetEmail could not reach ${base} for ${email}: ${(err as Error)?.message}`,
      );
      throw new ServiceUnavailableException(
        'Could not reach the email service. The account was not created.',
      );
    }

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(
        `sendPasswordResetEmail failed for ${email} (HTTP ${res.status}): ${body}`,
      );
      throw new ServiceUnavailableException(
        'Could not send the set-your-password email. The account was not created.',
      );
    }
  }
}

@Module({
  providers: [FirebaseService],
  exports: [FirebaseService], // Exports the service so its helpers can be read everywhere
})
export class FirebaseModule {}
