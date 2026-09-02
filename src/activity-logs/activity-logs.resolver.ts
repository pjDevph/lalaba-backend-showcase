import { Resolver, Query, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ActivityLogsService } from './activity-logs.service';
import { ActivityLog } from './schemas/activity-log.schema';
import { PaginatedActivityLogs } from './models/paginated-activity-logs.model';
import { ActivityLogFilterInput } from './dto/activity-log-filter.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

@Resolver(() => ActivityLog)
@UseGuards(GqlAuthGuard)
export class ActivityLogsResolver {
  constructor(private readonly activityLogsService: ActivityLogsService) {}

  private getMerchantId(user: User): string {
    const role = user.role as unknown as Role;
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  @RequirePermissions('log_view')
  @UseGuards(PermissionsGuard)
  @Query(() => PaginatedActivityLogs, { name: 'myActivityLogs' })
  async getMyActivityLogs(
    @Args('filter', { type: () => ActivityLogFilterInput, nullable: true })
    filter: ActivityLogFilterInput = {}, // NOSONAR — GraphQL decorator order must stay; default before @CurrentUser is intentional
    @CurrentUser() user: User,
  ): Promise<PaginatedActivityLogs> {
    const role = user.role as unknown as Role;
    const merchantId = this.getMerchantId(user);

    // Staff can only see their own logs — override any actorId from the client
    const scopedFilter =
      role?.roleId === 'staff' ? { ...filter, actorId: user._id } : filter;

    return this.activityLogsService.findAll(merchantId, scopedFilter);
  }
}
