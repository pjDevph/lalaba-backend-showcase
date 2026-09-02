import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { createHash } from 'crypto';
import { FirebaseService } from '../../firebase/firebase.service';
import { UsersService } from '../../users/users.service';
import { DevicesService } from '../../devices/devices.service';
import { MaintenanceService } from '../../maintenance/maintenance.service';
import { Role } from '../../users/schemas/role.schema';
import { ALLOW_UNREGISTERED_DEVICE } from '../decorators/allow-unregistered-device.decorator';
import { ALLOW_DELETION_PENDING } from '../decorators/allow-deletion-pending.decorator';
import { ALLOW_UNVERIFIED_COURIER } from '../decorators/allow-unverified-courier.decorator';
import { ALLOW_DURING_MAINTENANCE } from '../decorators/allow-during-maintenance.decorator';
import { AccountStatus } from '../../users/schemas/user.schema';

/** What the token cache holds — see the comment at its only write site. */
interface VerifiedToken {
  uid: string;
  issuedAtMs: number;
  usedSecondFactor: boolean;
}

@Injectable()
export class GqlAuthGuard implements CanActivate {
  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly usersService: UsersService,
    private readonly devicesService: DevicesService,
    private readonly maintenanceService: MaintenanceService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * `ADMIN_MFA_REQUIRED=on` enforces a second factor for admin/support.
   *
   * Matches the on/off convention used by MONGODB_ONLINE, STORAGE_ONLINE and
   * XENDIT_ONLINE. Anything other than 'on' is off, so a typo fails OPEN
   * rather than locking the team out of their own panel — the opposite of the
   * usual default, chosen because the failure it prevents is unrecoverable
   * without a console.
   */
  private adminMfaRequired(): boolean {
    return (
      (this.config.get<string>('ADMIN_MFA_REQUIRED') ?? '')
        .trim()
        .toLowerCase() === 'on'
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = GqlExecutionContext.create(context);
    const req = ctx.getContext().req;

    const authHeader = req?.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Authentication required. Please log in again.',
      );
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
      // Cache the verified token by a SHA-256 hash of the full token string.
      //
      // The cached value carries `issuedAt` and `usedSecondFactor` alongside
      // the uid, because both are properties of THIS token and are otherwise
      // unavailable on the cached path — the whole point of the cache is that
      // verifyIdToken() is not called again. Session revocation and the MFA
      // gate below both need them on every request, not just the first.
      //
      // The `v2` prefix is deliberate: entries written by the previous version
      // are bare uid strings, and reading one as an object would silently
      // yield `undefined` for both new fields — i.e. every pre-existing
      // session would read as "no second factor, issued at epoch".
      const tokenCacheKey = `firebase_token_v2:${createHash('sha256').update(idToken).digest('hex')}`;
      let verified = await this.cache.get<VerifiedToken>(tokenCacheKey);

      if (!verified) {
        const decodedToken = await this.firebaseService
          .getAuth()
          .verifyIdToken(idToken);
        verified = {
          uid: decodedToken.uid,
          // `iat` is in SECONDS since epoch, unlike everything else here.
          issuedAtMs: (decodedToken.iat ?? 0) * 1000,
          usedSecondFactor:
            decodedToken.firebase?.sign_in_second_factor != null,
        };
        await this.cache.set(tokenCacheKey, verified, 50 * 60 * 1000);
      }

      const uid = verified.uid;

      // Cache the full user+role document by uid
      const user = await this.usersService.findOneByIdWithRoleCached(uid);

      if (!user) throw new UnauthorizedException('Account not found.');
      if (!user.isActive) {
        // An account in its deletion grace period is inactive, but must still
        // reach cancelAccountDeletion (and nothing else) to undo the request.
        const allowDeletionPending = this.reflector.getAllAndOverride<boolean>(
          ALLOW_DELETION_PENDING,
          [context.getHandler(), context.getClass()],
        );
        if (
          user.accountStatus === AccountStatus.DELETION_PENDING &&
          allowDeletionPending
        ) {
          req.user = user;
          return true;
        }
        if (user.accountStatus === AccountStatus.DELETION_PENDING) {
          throw new UnauthorizedException(
            'This account is scheduled for deletion. Cancel the deletion request to restore access.',
          );
        }
        throw new UnauthorizedException('User account has been deactivated.');
      }

      // Sessions revoked by an admin (force logout) or by the account owner.
      // Checked before any role-specific gate: a revoked session must not
      // reach ANY handler, and a token already in the caller's hands stays
      // valid for up to an hour on Firebase's side alone.
      if (
        user.sessionsValidAfter &&
        verified.issuedAtMs < new Date(user.sessionsValidAfter).getTime()
      ) {
        // Its own code rather than a bare 401: the client signs out on this
        // one specifically. Treating every UNAUTHENTICATED as "session over"
        // would log people out on any transient token hiccup, since Firebase
        // refreshes tokens in the background.
        throw new GraphQLError(
          'Your session was ended by an administrator. Please log in again.',
          { extensions: { code: 'SESSION_REVOKED' } },
        );
      }

      const role = user.role as unknown as Role;

      // Second-factor requirement for back-office accounts.
      //
      // Config-gated and OFF by default, and that is not timidity: switching
      // it on rejects every admin who has not yet enrolled, including whoever
      // would need to log in to turn it back off. It is a deliberate operation
      // to run once the team has enrolled, not a default that surprises
      // someone at 2am.
      //
      // Applies only to admin/support — customers, providers and couriers
      // authenticate from phones and are not the threat model here.
      if (
        (role?.roleId === 'admin' || role?.roleId === 'support') &&
        this.adminMfaRequired() &&
        !verified.usedSecondFactor
      ) {
        throw new GraphQLError(
          'Two-factor authentication is required for back-office accounts. Enrol a second factor, then sign in again.',
          { extensions: { code: 'MFA_REQUIRED' } },
        );
      }

      if (role?.roleId === 'staff') {
        if (!user.merchantId)
          throw new UnauthorizedException(
            'Your account setup is incomplete. Contact your manager.',
          );

        // The registration/approval-status path (registerDevice, myDevice,
        // myBranchOptions) is reachable BEFORE the device is approved — that's
        // how a staff bootstraps a new device. Everything else requires an
        // approved device.
        const allowUnregistered = this.reflector.getAllAndOverride<boolean>(
          ALLOW_UNREGISTERED_DEVICE,
          [context.getHandler(), context.getClass()],
        );
        //
        // The approved device also decides WHICH BRANCH this staff member is
        // working, and therefore which of their per-branch permission grants
        // apply. That is set on the request below, never on `req.user` — the
        // user document is a shared cached object, so writing to it would leak
        // one device's branch onto a concurrent request for the same account.
        req.activeBranchId = null;
        if (!allowUnregistered) {
          const deviceToken = req?.headers?.['x-device-token'];
          if (!deviceToken)
            throw new UnauthorizedException(
              'Please log in from a registered device.',
            );
          const deviceAuth = await this.devicesService.resolveDeviceAuth(
            user.merchantId,
            deviceToken,
          );
          if (!deviceAuth.authorized)
            throw new UnauthorizedException(
              'This device is not registered or has been deactivated.',
            );
          // The device was only ever matched on (owner, token) — `staffUid` was
          // stored and never checked. That was a weak device gate when it only
          // decided whether to let someone in; now that the device selects the
          // branch whose grants apply, an unchecked token is a privilege
          // selector, so a co-worker's token no longer authenticates.
          // Legacy rows predating `staffUid` carry null and are let through on
          // the same grounds they always were.
          if (deviceAuth.staffUid && deviceAuth.staffUid !== String(user._id))
            throw new UnauthorizedException(
              'This device is registered to another account.',
            );
          if (!deviceAuth.branchId)
            throw new UnauthorizedException(
              'This device is not assigned to a branch. Ask your manager to approve it again.',
            );
          req.activeBranchId = deviceAuth.branchId;
        }
      }

      // A courier must hold a live liveness selfie before doing anything with
      // an order. Read off the cached user document rather than the
      // courier_selfies collection — this runs on every request, and the
      // denormalized field is what keeps it free.
      //
      // Deliberately a hard gate, unlike KYC's verificationStatus, which is
      // badge-only by design. The client mirrors this check for UX; this is the
      // one that actually enforces it.
      if (role?.roleId === 'courier') {
        const allowUnverified = this.reflector.getAllAndOverride<boolean>(
          ALLOW_UNVERIFIED_COURIER,
          [context.getHandler(), context.getClass()],
        );
        if (!allowUnverified && user.selfieStatus !== 'ACTIVE') {
          throw new UnauthorizedException(
            user.selfieStatus === 'REVOKED'
              ? 'Your profile photo was removed by an administrator. Take a new selfie to continue.'
              : 'Take your verification selfie before handling orders.',
          );
        }
      }

      // A suspended washer must not reach anything, order-related or not —
      // unlike the courier selfie gate, there is no "allow with a warning"
      // carve-out. Booking/discovery already reject WasherStatus !== ACTIVE
      // (ProviderEligibilityService, DiscoveryService), but neither of those
      // runs for e.g. profile reads, so this is the actual login block.
      if (role?.roleId === 'washer' && user.washerStatus === 'SUSPENDED') {
        throw new UnauthorizedException(
          'Your account has been suspended by an administrator. Contact support for more information.',
        );
      }

      // The maintenance block, if any, applies to whatever operation is
      // actually being called — checked last, after every other gate above,
      // and skipped entirely for handlers marked @AllowDuringMaintenance()
      // (the status poll the blocked app itself relies on).
      const allowDuringMaintenance = this.reflector.getAllAndOverride<boolean>(
        ALLOW_DURING_MAINTENANCE,
        [context.getHandler(), context.getClass()],
      );
      if (!allowDuringMaintenance) {
        const maintenance = await this.maintenanceService.effectiveStateForRole(
          role?.roleId,
          user._id,
        );
        if (maintenance.blocked) {
          throw new GraphQLError(
            maintenance.message ?? 'This app is temporarily unavailable.',
            {
              extensions: {
                code: 'MAINTENANCE_MODE',
                type: maintenance.type,
                message: maintenance.message,
                endsAt: maintenance.endsAt,
                // Carried on the REJECTION as well as on maintenanceStatus, so
                // the app can offer a way to reach support the instant it is
                // blocked rather than a poll interval later.
                supportEmail: maintenance.supportEmail,
                supportPhone: maintenance.supportPhone,
              },
            },
          );
        }
      }

      req.user = user;
      return true;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof GraphQLError
      ) {
        throw error;
      }
      throw new UnauthorizedException(
        'Session expired or invalid token authentication.',
      );
    }
  }
}
