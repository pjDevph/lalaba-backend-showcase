import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { Permission } from './schemas/permission.schema';
import { CreatePermissionInput } from './dto/create-permission.input';
import { UpdatePermissionInput } from './dto/update-permission.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import {
  ALL_PERMISSION_GROUPS,
  PermissionGroup,
  groupsFromNames,
} from './permission-groups';
import { grantsForBranch } from '../users/branch-access.util';

@Resolver(() => Permission)
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class PermissionsResolver {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Mutation(() => Permission)
  async createPermission(@Args('input') input: CreatePermissionInput) {
    return this.permissionsService.create(input);
  }

  /**
   * What the caller may do on the branch they are currently working, as groups.
   *
   * The app used to answer this itself: fetch the whole catalogue, match it
   * against the account-global `permissionIds`, and reverse-map the names into
   * its own gating keys. Under per-branch grants that union is the wrong answer
   * — it says "somewhere", and the UI would offer screens the guard then
   * refuses. Asking the server, in the same group vocabulary the owner granted
   * in, removes both the round-trip and the guesswork.
   *
   * Owners hold every group on every branch they own.
   */
  @Roles('merchant', 'staff')
  @Query(() => [PermissionGroup], { name: 'myPermissionGroups' })
  async myPermissionGroups(
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<PermissionGroup[]> {
    const roleId = (user.role as unknown as Role)?.roleId;
    if (roleId === 'merchant') return [...ALL_PERMISSION_GROUPS];

    const granted = grantsForBranch(user.branchAccess, activeBranchId);
    if (!granted.length) return [];

    const catalogue = await this.permissionsService.findAll();
    const held = new Set(granted);
    const names = catalogue
      .filter((p) => held.has(String((p as { _id: unknown })._id)))
      .map((p) => p.permissionName);
    return groupsFromNames(names);
  }

  @Roles('merchant', 'staff')
  @Query(() => [Permission], { name: 'listPermissions' })
  async listPermissions() {
    return this.permissionsService.findAll();
  }

  // Admin-panel-scoped read of the same catalogue — merchant-app staff and
  // admin-panel users are different callers of the same data, so this stays
  // a separate query rather than widening listPermissions's role list.
  @Roles('admin', 'support')
  @Query(() => [Permission], { name: 'listAdminPermissions' })
  async listAdminPermissions() {
    return this.permissionsService.findAll();
  }

  @Roles('merchant', 'staff')
  @Query(() => Permission, { name: 'getPermission' })
  async getPermission(@Args('id', { type: () => ID }) id: string) {
    return this.permissionsService.findById(id);
  }

  @Mutation(() => Permission)
  async updatePermission(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePermissionInput,
  ) {
    return this.permissionsService.update(id, input);
  }

  @Mutation(() => Boolean)
  async deletePermission(@Args('id', { type: () => ID }) id: string) {
    return this.permissionsService.delete(id);
  }
}
