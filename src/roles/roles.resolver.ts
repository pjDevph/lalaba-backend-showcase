import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { RolesService } from './roles.service';
import { Role } from '../users/schemas/role.schema';
import { CreateRoleInput } from './dto/create-role.input';
import { UpdateRoleInput } from './dto/update-role.input';
import { SignupRole } from './dto/signup-role.output';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

const ROLES_CACHE_KEY = 'roles:all';
const SIGNUP_ROLES_CACHE_KEY = 'roles:signup';
const ROLES_TTL = 60 * 60 * 1000; // 1 hour

@Resolver(() => Role)
export class RolesResolver {
  constructor(
    private readonly rolesService: RolesService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => Role)
  async createRole(@Args('input') input: CreateRoleInput) {
    const role = await this.rolesService.create(input);
    await this.cache.del(ROLES_CACHE_KEY);
    await this.cache.del(SIGNUP_ROLES_CACHE_KEY);
    return role;
  }

  /**
   * DELIBERATELY PUBLIC — the narrow replacement for anonymous `listRoles`
   * (SEC-004).
   *
   * Sign-up has a structural bootstrap problem: `registerUser` identifies the
   * chosen role by its Mongo `_id`, and the client must send that `_id` before
   * it has any token to authenticate with. So *some* role lookup has to be
   * reachable anonymously. The mistake was answering that need with the full
   * role catalogue.
   *
   * This query is scoped on both axes instead:
   *   - ROWS: only SELF_REGISTRABLE_ROLE_IDS — the same constant
   *     `UsersService.registerUser` enforces, so this can never advertise a
   *     role registration would reject. admin, support, staff and courier are
   *     not returned and are not discoverable here.
   *   - COLUMNS: the SignupRole projection — _id, roleId, roleName. No
   *     `description`, and no automatic inheritance of fields later added to
   *     Role, which is precisely how `listRoles` became a full dump.
   *
   * It stays behind the global 100/min throttler like every other route.
   */
  @Query(() => [SignupRole], { name: 'signupRoles' })
  async signupRoles(): Promise<SignupRole[]> {
    try {
      const cached = await this.cache.get<SignupRole[]>(SIGNUP_ROLES_CACHE_KEY);
      if (cached?.length) return cached;
    } catch {
      // Cache is best-effort: a read failure must not fail the query, it just
      // means we fall through to the database below.
    }
    const roles = await this.rolesService.findSelfRegistrable();
    try {
      await this.cache.set(SIGNUP_ROLES_CACHE_KEY, roles, ROLES_TTL);
    } catch {
      // A cache write failure is not worth failing an otherwise-successful
      // query — the fresh roles are already loaded and are returned below.
    }
    return roles;
  }

  // SEC-004: these two reads carried no guard at all, so an anonymous client
  // could enumerate every role document (ids, names, permission wiring) — a
  // free map of the authorization model. Brought in line with the mutations
  // on this resolver: authenticated + admin-only. Anonymous sign-up uses
  // `signupRoles` above instead.
  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Query(() => [Role], { name: 'listRoles' })
  async listRoles() {
    try {
      const cached = await this.cache.get<Role[]>(ROLES_CACHE_KEY);
      if (cached?.length) return cached;
    } catch {
      // Cache is best-effort: a read failure must not fail the query, it just
      // means we fall through to the database below.
    }
    const roles = await this.rolesService.findAll();
    try {
      await this.cache.set(ROLES_CACHE_KEY, roles, ROLES_TTL);
    } catch {
      // A cache write failure is not worth failing an otherwise-successful
      // query — the fresh roles are already loaded and are returned below.
    }
    return roles;
  }

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Query(() => Role, { name: 'getRole' })
  async getRole(@Args('id', { type: () => ID }) id: string) {
    return this.rolesService.findById(id);
  }

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => Role)
  async updateRole(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateRoleInput,
  ) {
    const role = await this.rolesService.update(id, input);
    await this.cache.del(ROLES_CACHE_KEY);
    await this.cache.del(SIGNUP_ROLES_CACHE_KEY);
    return role;
  }

  @Roles('admin')
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Mutation(() => Boolean)
  async deleteRole(@Args('id', { type: () => ID }) id: string) {
    const result = await this.rolesService.delete(id);
    await this.cache.del(ROLES_CACHE_KEY);
    await this.cache.del(SIGNUP_ROLES_CACHE_KEY);
    return result;
  }
}
