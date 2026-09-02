import { Args, Int, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { WasherService } from './washer.service';
import { WasherProfile, WasherStatus } from './schemas/washer-profile.schema';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { washerStoreName } from './washer-name.util';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';

// Separate from WasherResolver because that class is entirely @Roles('washer')
// — same reason WasherCertificationResolver is its own file. Nothing a washer
// may call belongs here: the daily order cap is Admin's decision, and it was
// previously settable by nobody at all (the field had no writer anywhere, so
// every washer ran on a hardcoded fallback instead).
@Resolver()
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class WasherAdminResolver {
  constructor(
    private readonly washerService: WasherService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Mutation(() => WasherProfile, { name: 'setWasherDailyOrderCap' })
  async setWasherDailyOrderCap(
    @CurrentUser() actor: User,
    @Args('branchId') branchId: string,
    // Nullable, and null is meaningful: it CLEARS the cap. There is no default
    // behind it — an unset cap means no per-washer daily order limit, with the
    // platform's booking policy still governing her slots.
    @Args('maxOrdersPerDay', { type: () => Int, nullable: true })
    maxOrdersPerDay?: number | null,
  ): Promise<WasherProfile> {
    const before = await this.washerService.findByBranchId(branchId);
    const updated = await this.washerService.setDailyOrderCap(
      branchId,
      maxOrdersPerDay ?? null,
    );
    await this.adminAudit.record({
      action: AdminAuditAction.PROVIDER_CAP_CHANGED,
      actor,
      targetType: AdminAuditTargetType.PROVIDER,
      targetId: branchId,
      targetLabel: washerStoreName(updated),
      // Before/after rather than just the new value: "who lowered her cap to
      // 3" is the question, and the new number alone cannot answer it.
      details: {
        from: before?.maxOrdersPerDay ?? null,
        to: maxOrdersPerDay ?? null,
      },
    });
    return updated;
  }

  /**
   * `reason` is REQUIRED. Suspension takes a washer's livelihood away with one
   * click; before this the mutation took a branchId and nothing else, and left
   * no record of who did it or why.
   */
  @Mutation(() => WasherProfile, { name: 'suspendWasher' })
  async suspendWasher(
    @CurrentUser() actor: User,
    @Args('branchId') branchId: string,
    @Args('reason') reason: string,
    @Args('note', {
      // Explicit () => String: a `string | null` union has no reflectable
      // design type, so the implicit form fails at schema-BUILD time — which
      // typecheck and unit tests both sail past, and only booting catches.
      type: () => String,
      nullable: true,
    })
    note: string | null,
  ): Promise<WasherProfile> {
    const updated = await this.washerService.setStatus(
      branchId,
      WasherStatus.SUSPENDED,
    );
    await this.adminAudit.record({
      action: AdminAuditAction.PROVIDER_SUSPENDED,
      actor,
      targetType: AdminAuditTargetType.PROVIDER,
      targetId: branchId,
      targetLabel: washerStoreName(updated),
      reasonCode: reason,
      note,
    });
    return updated;
  }

  @Mutation(() => WasherProfile, { name: 'reactivateWasher' })
  async reactivateWasher(
    @CurrentUser() actor: User,
    @Args('branchId') branchId: string,
    @Args('note', {
      // Explicit () => String: a `string | null` union has no reflectable
      // design type, so the implicit form fails at schema-BUILD time — which
      // typecheck and unit tests both sail past, and only booting catches.
      type: () => String,
      nullable: true,
    })
    note: string | null,
  ): Promise<WasherProfile> {
    const updated = await this.washerService.setStatus(
      branchId,
      WasherStatus.ACTIVE,
    );
    await this.adminAudit.record({
      action: AdminAuditAction.PROVIDER_REACTIVATED,
      actor,
      targetType: AdminAuditTargetType.PROVIDER,
      targetId: branchId,
      targetLabel: washerStoreName(updated),
      note,
    });
    return updated;
  }
}
