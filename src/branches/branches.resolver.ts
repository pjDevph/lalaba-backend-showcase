import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { Branch } from './schemas/branch.schema';
import { CreateBranchInput } from './dto/create-branch.input';
import { UpdateBranchInput } from './dto/update-branch.input';
import { BranchFilterInput } from './dto/branch-filter.input';
import { PaginatedBranches } from './models/paginated-branches.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => Branch)
@UseGuards(GqlAuthGuard)
export class BranchesResolver {
  constructor(private readonly branchesService: BranchesService) {}

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => [Branch])
  async createBranch(
    @Args('input', { type: () => [CreateBranchInput] })
    input: CreateBranchInput[],
    @CurrentUser() merchant: User,
  ) {
    return this.branchesService.create(input, merchant._id);
  }

  @Query(() => PaginatedBranches, { name: 'myBranches' })
  async getMyBranches(
    @Args('filter', { type: () => BranchFilterInput, nullable: true })
    filter: BranchFilterInput,
    @CurrentUser() user: User,
  ) {
    // STAFF see their merchant's branches; MERCHANT uses own _id.
    const uid = user.merchantId ?? user._id;
    return this.branchesService.findAllByMerchant(uid, filter);
  }

  @Query(() => Branch, { name: 'getBranch' })
  async getBranch(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    // STAFF read their merchant's branch; MERCHANT uses own _id.
    const uid = user.merchantId ?? user._id;
    return this.branchesService.findById(id, uid);
  }

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => Branch)
  async updateBranch(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateBranchInput,
    @CurrentUser() merchant: User,
  ) {
    return this.branchesService.update(id, merchant._id, input);
  }

  // Washers too: a home washer's anchor Branch is what carries the setting,
  // so both provider types toggle it through the same mutation.
  @Roles('merchant', 'washer')
  @UseGuards(RolesGuard)
  @Mutation(() => Branch)
  async setPayAtHandover(
    @Args('id', { type: () => ID }) id: string,
    @Args('enabled') enabled: boolean,
    @CurrentUser() provider: User,
  ) {
    return this.branchesService.setPayAtHandover(id, provider._id, enabled);
  }

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => Branch)
  async setBranchOnline(
    @Args('id', { type: () => ID }) id: string,
    @Args('isOnline') isOnline: boolean,
    @CurrentUser() merchant: User,
  ) {
    return this.branchesService.setOnline(id, merchant._id, isOnline);
  }

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => Branch)
  async archiveBranch(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() merchant: User,
  ) {
    return this.branchesService.archive(id, merchant._id);
  }

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => Branch)
  async restoreBranch(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() merchant: User,
  ) {
    return this.branchesService.restore(id, merchant._id);
  }
}
