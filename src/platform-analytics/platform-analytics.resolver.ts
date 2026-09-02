import { Args, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { PlatformAnalyticsService } from './platform-analytics.service';
import { PlatformOverview } from './models/platform-overview.model';
import { PlatformAnalyticsRangeInput } from './dto/platform-analytics-range.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Platform-wide reporting across every provider. Admin-only — GMV and
 * revenue figures are the same class of information as the fee rules that
 * produce them, not a support lookup surface.
 */
@Resolver()
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class PlatformAnalyticsResolver {
  constructor(private readonly platformAnalytics: PlatformAnalyticsService) {}

  @Query(() => PlatformOverview, { name: 'platformOverview' })
  async platformOverview(
    @Args('range', { nullable: true }) range?: PlatformAnalyticsRangeInput,
  ): Promise<PlatformOverview> {
    return this.platformAnalytics.overview(range ?? {});
  }
}
