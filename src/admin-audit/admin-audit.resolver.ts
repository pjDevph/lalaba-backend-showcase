import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { AdminAuditService } from './admin-audit.service';
import { AdminAuditEvent } from './schemas/admin-audit-event.schema';
import { AdminAuditFilterInput } from './dto/admin-audit-filter.input';
import { PaginatedAdminAuditEvents } from './models/paginated-admin-audit.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Read-only by construction. There is no mutation here and there must never
 * be one: the trail is append-only, and the only writers are the services
 * recording their own actions.
 *
 * Admin-only rather than admin+support. Support appears IN this log; letting
 * them read the whole platform's trail is a different privilege from doing
 * their job, and the panel already scopes what they can act on.
 */
@Resolver(() => AdminAuditEvent)
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class AdminAuditResolver {
  constructor(private readonly auditService: AdminAuditService) {}

  @Query(() => PaginatedAdminAuditEvents, { name: 'adminAuditLog' })
  async adminAuditLog(
    @Args('filter', { nullable: true }) filter?: AdminAuditFilterInput,
  ): Promise<PaginatedAdminAuditEvents> {
    return this.auditService.find(filter ?? {});
  }

  /**
   * `details` is a Mixed sub-document whose shape differs per action, so it
   * has no GraphQL type. Serialised here rather than stored as a string, so
   * Mongo can still query into it.
   */
  @ResolveField(() => String, { nullable: true })
  detailsJson(@Parent() event: AdminAuditEvent): string | null {
    return event.details ? JSON.stringify(event.details) : null;
  }
}
