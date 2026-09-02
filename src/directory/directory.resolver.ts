import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { DirectoryService } from './directory.service';
import {
  DirectoryUserDetail,
  ImpersonationToken,
  PaginatedDirectoryUsers,
} from './models/directory-user.model';
import { DirectoryFilterInput } from './dto/directory-filter.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';

/**
 * Read-only account directory, with one exception.
 *
 * Admin AND support: answering "who is this person and what have they done"
 * is the first step of nearly every support call, and gating it to admin
 * would mean an agent cannot look up the customer they are already talking to.
 *
 * `impersonateUser` is the exception, and it is admin-only via its own
 * `@Roles`, which overrides the class-level one — this is the single most
 * sensitive action in the panel, more so than a platform broadcast, because
 * it grants live access to one specific person's account rather than sending
 * a message. Every other action here — deactivate, reactivate, force logout —
 * already exists on UsersResolver, already requires a reason code, and is
 * already audited; this file does not duplicate those.
 */
@Resolver()
@Roles('admin', 'support')
@UseGuards(GqlAuthGuard, RolesGuard)
export class DirectoryResolver {
  constructor(
    private readonly directoryService: DirectoryService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Query(() => PaginatedDirectoryUsers, { name: 'directoryUsers' })
  async directoryUsers(
    @Args('filter', { nullable: true }) filter?: DirectoryFilterInput,
  ): Promise<PaginatedDirectoryUsers> {
    return this.directoryService.list(filter ?? {});
  }

  @Query(() => DirectoryUserDetail, { name: 'directoryUser' })
  async directoryUser(
    @Args('uid', { type: () => ID }) uid: string,
  ): Promise<DirectoryUserDetail> {
    return this.directoryService.detail(uid);
  }

  /**
   * `reason` is required. The audit record is written BEFORE the token is
   * minted, reversing the order used everywhere else in the panel.
   *
   * Everywhere else, recording after success is correct: the audit trail
   * must never claim an action happened before it actually did. Here the
   * ordering flips because `AdminAuditService.record()` never throws — a
   * failed write is logged loudly but does not stop the caller — so writing
   * it first is the only way to guarantee the attempt is on record even if
   * something later in this method throws. There is no way to un-mint a
   * token already handed to an admin, so the highest-sensitivity mutation in
   * the panel gets the one exception to "record after success".
   */
  @Roles('admin')
  @Mutation(() => ImpersonationToken)
  async impersonateUser(
    @Args('uid', { type: () => ID }) uid: string,
    @Args('reason') reason: string,
    @Args('note', { type: () => String, nullable: true }) note: string | null,
    @CurrentUser() actor: User,
  ): Promise<ImpersonationToken> {
    await this.adminAudit.record({
      action: AdminAuditAction.IMPERSONATION_STARTED,
      actor,
      targetType: AdminAuditTargetType.USER,
      targetId: uid,
      reasonCode: reason,
      note,
    });
    return this.directoryService.impersonate(uid, String(actor._id));
  }
}
