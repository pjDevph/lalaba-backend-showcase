import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { SearchService } from './search.service';
import { OperationalSearchResults } from './models/search-result.model';

/**
 * The back office's one search box.
 *
 * Guarded ('admin', 'support') like the resolvers it reaches across, and the
 * service narrows further per entity type from the CALLER'S OWN ROLE — this
 * query must not become a way around a guard that a dedicated resolver still
 * enforces. A type the caller may not search is never queried, and the result
 * says which types were searched so the UI can distinguish "not searched" from
 * "nothing found".
 */
@Resolver()
@UseGuards(GqlAuthGuard, RolesGuard)
export class SearchResolver {
  constructor(private readonly searchService: SearchService) {}

  @Roles('admin', 'support')
  @Query(() => OperationalSearchResults, {
    name: 'searchOperationalEntities',
  })
  async searchOperationalEntities(
    @Args('query') query: string,
    @CurrentUser() user: User,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<OperationalSearchResults> {
    const role = user.role as unknown as Role | undefined;
    return this.searchService.search(
      query,
      role?.roleId ?? '',
      // Capped server-side: this feeds a dropdown, and a caller asking for
      // 10,000 results is asking for a dump of the platform.
      Math.min(Math.max(limit ?? 20, 1), 50),
    );
  }
}
