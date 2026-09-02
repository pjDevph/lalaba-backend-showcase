import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { FirebaseService } from '../../firebase/firebase.service';
import { REQUIRE_APP_CHECK } from '../decorators/require-app-check.decorator';

/** The header Firebase's client SDKs and docs use for custom backends. */
export const APP_CHECK_HEADER = 'x-firebase-appcheck';

/**
 * APPCHK-011/012/013 — verifies a Firebase App Check token on handlers marked
 * @RequireAppCheck().
 *
 * APPCHK-014 — this answers a DIFFERENT question from GqlAuthGuard, and the
 * two are deliberately not merged:
 *
 *   Firebase ID token (GqlAuthGuard)  ->  WHO is the user?
 *   App Check token   (this guard)    ->  is this a genuine build of our app
 *                                          on a genuine device?
 *
 * Neither substitutes for the other. A stolen ID token replayed from a script
 * fails App Check; a genuine app with no session fails auth. The operations
 * this guard protects first — requestBiometricChallenge and biometricLogin —
 * have no session at all by definition, which is exactly why they were the
 * abuse surface in the original finding.
 */
@Injectable()
export class AppCheckGuard implements CanActivate {
  private readonly logger = new Logger(AppCheckGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly firebaseService: FirebaseService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `APP_CHECK_ENFORCED=on` turns verification on.
   *
   * OFF by default and the default is not timidity — it is Firebase's own
   * sequencing advice. Enforcement must not precede client coverage: every
   * first-party app has to be registered and shipping attestations, and the
   * App Check metrics have to show legitimate traffic arriving verified,
   * before anything starts rejecting. Flipping this early locks out real
   * customers on older installs that predate the App Check build.
   *
   * Same on/off convention as MONGODB_ONLINE, STORAGE_ONLINE, XENDIT_ONLINE
   * and ADMIN_MFA_REQUIRED. Anything other than 'on' is off.
   */
  private enforced(): boolean {
    return (
      (this.config.get<string>('APP_CHECK_ENFORCED') ?? '')
        .trim()
        .toLowerCase() === 'on'
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_APP_CHECK,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const ctx = GqlExecutionContext.create(context);
    const req = ctx.getContext()?.req;
    const rawHeader: unknown = req?.headers?.[APP_CHECK_HEADER];
    const token = typeof rawHeader === 'string' ? rawHeader.trim() : '';

    if (!this.enforced()) {
      // Monitoring mode. Still verify when a token IS present, so the logs
      // show whether real clients are attesting successfully — that evidence
      // is the precondition for turning enforcement on, and it cannot be
      // gathered after the fact.
      if (token) {
        try {
          await this.firebaseService.getAppCheck().verifyToken(token);
          this.logger.debug('App Check token verified (monitoring mode)');
        } catch {
          this.logger.warn(
            'App Check token present but INVALID (monitoring mode — request allowed). ' +
              'Investigate before enabling APP_CHECK_ENFORCED.',
          );
        }
      } else {
        this.logger.debug(
          'App Check token absent (monitoring mode — request allowed)',
        );
      }
      return true;
    }

    if (!token) {
      throw new GraphQLError(
        'This app could not be verified. Update to the latest version from the app store.',
        { extensions: { code: 'APP_CHECK_REQUIRED' } },
      );
    }

    try {
      await this.firebaseService.getAppCheck().verifyToken(token);
      return true;
    } catch {
      // Never echo the verifier's message back: it distinguishes expired from
      // malformed from wrong-project, which is free reconnaissance for anyone
      // probing. The detail stays in the server log.
      this.logger.warn('App Check verification failed — request rejected');
      throw new GraphQLError(
        'This app could not be verified. Update to the latest version from the app store.',
        { extensions: { code: 'APP_CHECK_INVALID' } },
      );
    }
  }
}
