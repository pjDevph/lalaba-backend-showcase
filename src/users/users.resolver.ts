import { UseGuards, BadRequestException } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AllowUnregisteredDevice } from '../auth/decorators/allow-unregistered-device.decorator';
import { AllowUnverifiedCourier } from '../auth/decorators/allow-unverified-courier.decorator';
import {
  Resolver,
  Mutation,
  Query,
  Args,
  ResolveField,
  Parent,
  Context,
  Int,
} from '@nestjs/graphql';
import { UsersService } from './users.service';
import { UserType } from './models/user.model';
import { RegisterUserInput } from './dto/register-user.input';
import { UpdateUserInput } from './dto/update-user.input';
import { UserFilterInput } from './dto/user-filter.input';
import { CreateAdminUserInput } from './dto/create-admin-user.input';
import { PaginatedUsers } from './models/paginated-users.model';
import { PaginatedMerchants } from './models/paginated-merchants.model';
import { Role } from './schemas/role.schema';
import { User } from './schemas/user.schema';
import { RoleLoader } from './role.loader';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';

@Resolver(() => UserType)
export class UsersResolver {
  constructor(
    private readonly usersService: UsersService,
    private readonly roleLoader: RoleLoader,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Mutation(() => UserType)
  async registerUser(
    @Args('input') input: RegisterUserInput,
    @Context() context: any,
  ) {
    const authHeader = context.req?.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new BadRequestException(
        'Authentication required. Please log in again.',
      );
    }

    const idToken = authHeader.split('Bearer ')[1];
    return this.usersService.register(input, idToken);
  }

  // Reachable WITHOUT an approved device: a staff must be able to read their own
  // profile (role, branchIds) on an unregistered device so the app can route
  // them to device registration. Only returns the caller's own record.
  //
  // Same reasoning for AllowUnverifiedCourier: the app calls `me` during auth
  // bootstrap, before it knows the role — so a courier who has not taken their
  // selfie yet must still be able to read their own profile, or routing can
  // never reach the selfie screen.
  @Query(() => UserType, {
    name: 'me',
    nullable: true,
    description: 'Fetches the current authenticated user profile',
  })
  @AllowUnregisteredDevice()
  @AllowUnverifiedCourier()
  @UseGuards(GqlAuthGuard)
  async getMe(@CurrentUser() user: User) {
    return user;
  }

  @Mutation(() => UserType)
  @UseGuards(GqlAuthGuard)
  async updateUser(
    @Args('input') input: UpdateUserInput,
    @CurrentUser() user: User,
  ) {
    return this.usersService.updateUser(user._id, input);
  }

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Query(() => PaginatedUsers, { name: 'listUsers' })
  async listUsers(
    @Args('filter', { type: () => UserFilterInput, nullable: true })
    filter: UserFilterInput,
  ) {
    return this.usersService.listUsers(filter);
  }

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => UserType)
  async createAdminUser(@Args('input') input: CreateAdminUserInput) {
    return this.usersService.createAdminUser(input);
  }

  @Roles('admin', 'support')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Query(() => PaginatedUsers, { name: 'listAdminUsers' })
  async listAdminUsers(
    @Args('filter', { type: () => UserFilterInput, nullable: true })
    filter: UserFilterInput,
  ) {
    return this.usersService.listAdminPanelUsers(filter);
  }

  /**
   * Force-log-out another account, everywhere, immediately.
   *
   * Admin-only and audited. The commonest real use is an agent's laptop going
   * missing — which is also why it does not require the account to be
   * deactivated first: those are different decisions, and making one imply
   * the other would mean the only way to end a session is to also stop
   * someone working.
   */
  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => Boolean)
  async revokeUserSessions(
    @Args('uid') uid: string,
    @Args('reason') reason: string,
    @Args('note', {
      type: () => String,
      nullable: true,
    })
    note: string | null,
    @CurrentUser() actor: User,
  ) {
    const target = await this.usersService.revokeSessions(uid);
    await this.adminAudit.record({
      action: AdminAuditAction.SESSIONS_REVOKED,
      actor,
      targetType: AdminAuditTargetType.USER,
      targetId: uid,
      targetLabel:
        `${target.firstName ?? ''} ${target.lastName ?? ''}`.trim() ||
        target.email,
      reasonCode: reason,
      note,
    });
    return true;
  }

  /**
   * Sign out of every OTHER session, including this one.
   *
   * Self-service and open to any signed-in account: "I logged in on a shared
   * machine" should not require finding an admin. Not audited to the platform
   * trail — it is not an action taken ON someone, it is someone acting on
   * their own account.
   */
  @UseGuards(GqlAuthGuard)
  @Mutation(() => Boolean)
  async revokeMySessions(@CurrentUser() user: User) {
    await this.usersService.revokeSessions(String(user._id));
    return true;
  }

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => Boolean)
  async resendAdminInvite(@Args('uid') uid: string) {
    await this.usersService.resendAdminInvite(uid);
    return true;
  }

  @Roles('admin', 'support')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Query(() => PaginatedMerchants, { name: 'listMerchants' })
  async listMerchants(
    @Args('filter', { type: () => UserFilterInput, nullable: true })
    filter: UserFilterInput,
  ) {
    return this.usersService.listMerchants(filter);
  }

  @Roles('admin', 'support')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Query(() => Int, { name: 'countUsersByRole' })
  async countUsersByRole(@Args('roleId') roleId: string) {
    return this.usersService.countByRole(roleId);
  }

  /**
   * `reason` is REQUIRED, and that is the point of this signature.
   *
   * This mutation previously took a uid and nothing else: it could not say who
   * deactivated the account or why, and wrote no record anywhere. A structured
   * code rather than free text so "why do we deactivate most accounts" is
   * answerable without reading prose.
   */
  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => UserType)
  async deactivateUser(
    @Args('uid') uid: string,
    @Args('reason') reason: string,
    @Args('note', {
      // Explicit () => String: a `string | null` union has no reflectable
      // design type, so the implicit form fails at schema-BUILD time — which
      // typecheck and unit tests both sail past, and only booting catches.
      type: () => String,
      nullable: true,
    })
    note: string | null,
    @CurrentUser() actor: User,
  ) {
    const updated = await this.usersService.deactivateUser(uid, actor._id);
    // Recorded AFTER the write succeeds — a trail that claims things which
    // never happened is worse than one with a gap.
    await this.adminAudit.record({
      action: AdminAuditAction.ACCOUNT_DEACTIVATED,
      actor,
      targetType: AdminAuditTargetType.USER,
      targetId: uid,
      targetLabel:
        `${updated.firstName ?? ''} ${updated.lastName ?? ''}`.trim() ||
        updated.email,
      reasonCode: reason,
      note,
    });
    return updated;
  }

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => UserType)
  async reactivateUser(
    @Args('uid') uid: string,
    @Args('note', {
      // Explicit () => String: a `string | null` union has no reflectable
      // design type, so the implicit form fails at schema-BUILD time — which
      // typecheck and unit tests both sail past, and only booting catches.
      type: () => String,
      nullable: true,
    })
    note: string | null,
    @CurrentUser() actor: User,
  ) {
    const updated = await this.usersService.reactivateUser(uid);
    // No reason code: reversing a deactivation restores the default state, so
    // there is no taxonomy worth counting. Who and when still matter.
    await this.adminAudit.record({
      action: AdminAuditAction.ACCOUNT_REACTIVATED,
      actor,
      targetType: AdminAuditTargetType.USER,
      targetId: uid,
      targetLabel:
        `${updated.firstName ?? ''} ${updated.lastName ?? ''}`.trim() ||
        updated.email,
      note,
    });
    return updated;
  }

  @ResolveField(() => Role, { name: 'role', nullable: true })
  async getRole(@Parent() user: User) {
    if (!user.role) return null;
    // A populated Role subdocument has its own fields (roleId, roleName) —
    // an unpopulated ref is just a Mongo ObjectId, which is ALSO
    // `typeof === 'object'`, so that alone can't tell them apart. Lean
    // queries (myStaff/listUsers/listAdminUsers) return the latter and need
    // the loader below; only a real populated doc can be returned as-is.
    if (typeof user.role === 'object' && 'roleId' in user.role) {
      return user.role;
    }
    // Batched per-request — avoids one query per user when resolving `role`
    // across a list (myStaff/listUsers return lean docs without a populated role).
    return this.roleLoader.load(user.role.toString());
  }
}
