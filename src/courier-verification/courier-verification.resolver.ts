import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { CourierVerificationService } from './courier-verification.service';
import { CourierSelfie } from './schemas/courier-selfie.schema';
import { SubmitCourierSelfieInput } from './dto/submit-courier-selfie.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';
import { AllowUnverifiedCourier } from '../auth/decorators/allow-unverified-courier.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => CourierSelfie)
@UseGuards(GqlAuthGuard, RolesGuard)
export class CourierVerificationResolver {
  constructor(
    private readonly service: CourierVerificationService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  // ─── Courier-facing ────────────────────────────────────────────────────────
  // Both carry @AllowUnverifiedCourier for the obvious reason: they ARE the
  // bootstrap. Without it the gate would refuse the only two calls that can
  // open it, and every courier would be permanently locked out.

  @Roles('courier')
  @AllowUnverifiedCourier()
  @Mutation(() => CourierSelfie, {
    name: 'submitCourierSelfie',
    description:
      "Upload a liveness-checked selfie. Goes live immediately and becomes the courier's profile picture; admins review after the fact.",
  })
  async submitCourierSelfie(
    @Args('input') input: SubmitCourierSelfieInput,
    @CurrentUser() user: User,
  ): Promise<CourierSelfie> {
    return this.service.submitSelfie(user, input);
  }

  @Roles('courier')
  @AllowUnverifiedCourier()
  @Query(() => CourierSelfie, {
    name: 'myCourierSelfie',
    nullable: true,
    description:
      "The calling courier's most recent selfie, or null if they have never submitted one. Read by the client gate; a status other than ACTIVE means order handling is locked.",
  })
  async myCourierSelfie(
    @CurrentUser() user: User,
  ): Promise<CourierSelfie | null> {
    return this.service.myCurrentSelfie(user._id);
  }

  // ─── Admin-facing ──────────────────────────────────────────────────────────

  @Roles('admin', 'support')
  @Query(() => [CourierSelfie], {
    name: 'courierSelfieQueue',
    description:
      'Live courier selfies, newest first, for post-hoc review. There is no approve step — the only verdict is revoke.',
  })
  async courierSelfieQueue(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 25 })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number,
  ): Promise<CourierSelfie[]> {
    return this.service.reviewQueue(limit, offset);
  }

  @Roles('admin', 'support')
  @Mutation(() => CourierSelfie, {
    name: 'revokeCourierSelfie',
    description:
      'Take a selfie down: re-locks the courier and deletes the image from the public bucket. Reason is mandatory.',
  })
  async revokeCourierSelfie(
    @Args('selfieId', { type: () => ID }) selfieId: string,
    @Args('reason') reason: string,
    @CurrentUser() user: User,
  ): Promise<CourierSelfie> {
    const revoked = await this.service.revokeSelfie(selfieId, user._id, reason);
    // The service already stores the reason ON the selfie, because the courier
    // is shown it. This records the same act in the platform-wide trail, where
    // the question is "what did this admin do today" rather than "why am I
    // locked out".
    await this.adminAudit.record({
      action: AdminAuditAction.COURIER_SELFIE_REVOKED,
      actor: user,
      targetType: AdminAuditTargetType.COURIER_SELFIE,
      targetId: selfieId,
      targetLabel: revoked.courierUid,
      note: reason,
    });
    return revoked;
  }
}
