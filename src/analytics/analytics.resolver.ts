import { Resolver, Query, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsFilterInput } from './dto/analytics-filter.input';
import {
  RevenueSummary,
  BranchRevenueSummary,
} from './models/revenue-summary.model';
import { RevenueDataPoint } from './models/revenue-over-time.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver()
@RequirePermissions('report_view')
@UseGuards(GqlAuthGuard, PermissionsGuard)
export class AnalyticsResolver {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Query(() => RevenueSummary, { name: 'revenueSummary' })
  async getRevenueSummary(
    @Args('filter') filter: AnalyticsFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<RevenueSummary> {
    return this.analyticsService.getRevenueSummary(
      this.analyticsService.getMerchantId(user),
      this.analyticsService.getBranchIds(user, activeBranchId),
      filter,
    );
  }

  @Query(() => [BranchRevenueSummary], { name: 'revenueSummaryByBranch' })
  async getRevenueSummaryByBranch(
    @Args('filter') filter: AnalyticsFilterInput,
    @CurrentUser() user: User,
  ): Promise<BranchRevenueSummary[]> {
    return this.analyticsService.getRevenueSummaryByBranch(
      this.analyticsService.getMerchantId(user),
      filter,
    );
  }

  @Query(() => [RevenueDataPoint], { name: 'revenueOverTime' })
  async getRevenueOverTime(
    @Args('filter') filter: AnalyticsFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<RevenueDataPoint[]> {
    return this.analyticsService.getRevenueOverTime(
      this.analyticsService.getMerchantId(user),
      this.analyticsService.getBranchIds(user, activeBranchId),
      filter,
    );
  }

  // Server-side gate for report/data exports. Reports are rendered from
  // `myOrders`/inventory data that staff can already view, so export files are
  // generated on the client — this endpoint is the authorization checkpoint the
  // export flow must clear first, so the permission is enforced on the backend
  // and not only by hiding the button. The method-level decorator overrides the
  // class-level `report_view` requirement.
  @Query(() => Boolean, { name: 'assertReportExport' })
  @RequirePermissions('report_export')
  assertReportExport(): boolean {
    return true;
  }
}
