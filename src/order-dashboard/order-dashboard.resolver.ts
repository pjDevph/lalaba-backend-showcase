import { Resolver, Query, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { OrderDashboardService } from './order-dashboard.service';
import { PaginatedDashboardOrders } from './models/paginated-dashboard-orders.model';
import { DashboardFilterInput } from './dto/dashboard-filter.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver()
@Roles('merchant', 'washer', 'staff')
@UseGuards(GqlAuthGuard, RolesGuard)
export class OrderDashboardResolver {
  constructor(private readonly dashboardService: OrderDashboardService) {}

  @Query(() => PaginatedDashboardOrders, { name: 'orderDashboard' })
  async orderDashboard(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('filter', { type: () => DashboardFilterInput, nullable: true })
    filter: DashboardFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    return this.dashboardService.getDashboard(
      branchId,
      user,
      filter,
      activeBranchId,
    );
  }
}
