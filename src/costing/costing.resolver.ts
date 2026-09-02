import { Resolver, Query, Mutation, Args, ID, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { CostingService } from './costing.service';
import { CostingReportEntry } from './models/costing-report-entry.model';
import { CostingReportStub } from './models/costing-report-stub.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

@Resolver()
@UseGuards(GqlAuthGuard, PermissionsGuard)
export class CostingResolver {
  constructor(private readonly costingService: CostingService) {}

  private getMerchantId(user: User): string {
    const role = user.role as unknown as Role;
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  @RequirePermissions('costing_create', 'costing_update')
  @Query(() => Object, { name: 'costingConfig' })
  async getCostingConfig(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ): Promise<Record<string, any>> {
    return this.costingService.getCostingConfig(
      branchId,
      this.getMerchantId(user),
    );
  }

  @RequirePermissions('costing_update')
  @Mutation(() => Boolean, { name: 'upsertCostingConfig' })
  async upsertCostingConfig(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('config', { type: () => Object }) config: Record<string, unknown>,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    await this.costingService.upsertCostingConfig(
      branchId,
      this.getMerchantId(user),
      config,
    );
    return true;
  }

  @RequirePermissions('costing_create', 'costing_update')
  @Query(() => [CostingReportEntry], { name: 'costingReports' })
  async getCostingReports(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('limit', { type: () => Int, nullable: true })
    limit: number | undefined,
    @CurrentUser() user: User,
  ): Promise<CostingReportEntry[]> {
    return this.costingService.getCostingReports(
      branchId,
      this.getMerchantId(user),
      limit,
    );
  }

  @RequirePermissions('costing_create', 'costing_update')
  @Mutation(() => CostingReportStub, { name: 'upsertCostingReport' })
  async upsertCostingReport(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('report', { type: () => Object }) report: Record<string, unknown>,
    @CurrentUser() user: User,
  ): Promise<CostingReportStub> {
    return this.costingService.upsertCostingReport(
      branchId,
      this.getMerchantId(user),
      report,
      user._id,
    );
  }
}
