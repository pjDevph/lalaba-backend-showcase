import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { StaffService } from './staff.service';
import { UserType } from '../users/models/user.model';
import { PaginatedStaff } from './models/paginated-staff.model';
import { CreateStaffInput } from './dto/create-staff.input';
import { UpdateStaffInput } from './dto/update-staff.input';
import { StaffFilterInput } from './dto/staff-filter.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/schemas/user.schema';

// Merchant and washer both hire staff/couriers under their own account (§5);
// "merchantId" below is really just "the inviting owner's uid" for either.
const OWNER_ROLES = ['merchant', 'washer'];

@Resolver(() => UserType)
@Roles(...OWNER_ROLES)
@UseGuards(GqlAuthGuard, RolesGuard)
export class StaffResolver {
  constructor(private readonly staffService: StaffService) {}

  @Mutation(() => UserType)
  async createStaff(
    @Args('input') input: CreateStaffInput,
    @CurrentUser() owner: User,
  ) {
    // The owner's role decides WHICH roles they may invite — a washer may
    // create couriers only. RolesGuard has already populated `role` to admit
    // this request, so it is read here rather than re-queried in the service.
    const ownerRoleId = (owner.role as unknown as { roleId?: string })?.roleId;
    return this.staffService.createStaff(input, owner._id, ownerRoleId);
  }

  @Query(() => PaginatedStaff, { name: 'myStaff' })
  async getMyStaff(
    @Args('filter', { type: () => StaffFilterInput, nullable: true })
    filter: StaffFilterInput,
    @CurrentUser() owner: User,
  ) {
    return this.staffService.findAllByMerchant(owner._id, filter);
  }

  @Query(() => UserType, { name: 'getStaff' })
  async getStaff(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() owner: User,
  ) {
    return this.staffService.findById(id, owner._id);
  }

  @Mutation(() => UserType)
  async updateStaff(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateStaffInput,
    @CurrentUser() owner: User,
  ) {
    return this.staffService.updateStaff(id, owner._id, input);
  }

  @Mutation(() => UserType)
  async archiveStaff(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() owner: User,
  ) {
    return this.staffService.archiveStaff(id, owner._id);
  }

  @Mutation(() => UserType)
  async restoreStaff(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() owner: User,
  ) {
    return this.staffService.restoreStaff(id, owner._id);
  }

  @Mutation(() => String)
  async generateStaffResetLink(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() owner: User,
  ) {
    return this.staffService.generatePasswordResetLink(id, owner._id);
  }
}
