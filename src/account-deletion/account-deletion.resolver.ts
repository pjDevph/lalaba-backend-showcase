import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ForbiddenException, UseGuards } from '@nestjs/common';
import { Role } from '../users/schemas/role.schema';

const DELETION_CANCEL_ADMIN_ROLES = ['admin', 'support'];
import { AccountDeletionService } from './account-deletion.service';
import { DeletionBlocker } from './models/deletion-blocker.model';
import { DeletionQueueEntry } from './models/deletion-queue-entry.model';
import { ScheduledDeletionRunResult } from './models/scheduled-deletion-run.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AllowDeletionPending } from '../auth/decorators/allow-deletion-pending.decorator';
import { AllowUnverifiedCourier } from '../auth/decorators/allow-unverified-courier.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { UserType } from '../users/models/user.model';

@Resolver()
@UseGuards(GqlAuthGuard)
export class AccountDeletionResolver {
  constructor(
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  // Deletion stays reachable for a courier who has not taken their selfie —
  // leaving the account permanently, and it must not be possible to trap
  // someone in an account they cannot use and cannot close.
  @AllowUnverifiedCourier()
  @Query(() => [DeletionBlocker], {
    name: 'accountDeletionBlockers',
    description:
      'Side-effect-free pre-check of what currently blocks requestAccountDeletion for the calling account. Empty list means the account is clear to delete.',
  })
  async accountDeletionBlockers(
    @CurrentUser() user: User,
  ): Promise<DeletionBlocker[]> {
    return this.accountDeletionService.listBlockers(user._id);
  }

  @AllowUnverifiedCourier()
  @Mutation(() => UserType, {
    name: 'requestAccountDeletion',
    description:
      "Self-service deletion request: locks the caller's own login immediately (subject to blockers) and schedules irreversible PII erasure 30 days later. Cancellable at any point in that window with cancelAccountDeletion.",
  })
  async requestAccountDeletion(@CurrentUser() user: User): Promise<User> {
    return this.accountDeletionService.requestDeletion(user._id);
  }

  // The only operation an account inside its grace period may still call —
  // see AllowDeletionPending / GqlAuthGuard. Admin/support may pass a uid to
  // cancel on a user's behalf; everyone else cancels their own.
  @Mutation(() => UserType, {
    name: 'cancelAccountDeletion',
    description:
      'Cancels a pending account-deletion request and restores access. The owner may call it during the grace period; admin/support may pass a uid to cancel on someone’s behalf. Impossible once erasure has run.',
  })
  @AllowDeletionPending()
  @AllowUnverifiedCourier()
  async cancelAccountDeletion(
    @CurrentUser() user: User,
    @Args('uid', { type: () => ID, nullable: true }) uid?: string,
  ): Promise<User> {
    const target = uid ?? user._id;
    if (target !== user._id) {
      // Cancelling someone else's request is an admin/support action. Checked
      // here rather than with RolesGuard because the self-service path must
      // stay open to every role.
      const roleId = (user.role as unknown as Role)?.roleId;
      if (!DELETION_CANCEL_ADMIN_ROLES.includes(roleId)) {
        throw new ForbiddenException(
          'You can only cancel your own account deletion request.',
        );
      }
    }
    return this.accountDeletionService.cancelDeletion(target, user._id);
  }

  @Query(() => [DeletionQueueEntry], {
    name: 'accountDeletionQueue',
    description:
      'Admin/support: every account currently in the deletion grace period, plus recent cancellations and completions for audit context.',
  })
  @Roles('admin', 'support')
  @UseGuards(GqlAuthGuard, RolesGuard)
  async accountDeletionQueue(
    @Args('status', { type: () => String, nullable: true })
    status?: 'pending' | 'cancelled' | 'completed',
  ): Promise<DeletionQueueEntry[]> {
    return this.accountDeletionService.listDeletionQueue(status);
  }

  @Mutation(() => ScheduledDeletionRunResult, {
    name: 'runScheduledAccountDeletions',
    description:
      'Admin/support: runs the grace-period erasure sweep immediately instead of waiting for the nightly job. Idempotent — only accounts whose scheduled date has passed are touched.',
  })
  @Roles('admin', 'support')
  @UseGuards(GqlAuthGuard, RolesGuard)
  async runScheduledAccountDeletions(): Promise<ScheduledDeletionRunResult> {
    return this.accountDeletionService.processScheduledDeletions();
  }
}
