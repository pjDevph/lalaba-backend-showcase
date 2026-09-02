import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { OperationalContextService } from './operational-context.service';
import {
  ContextSubjectType,
  OperationalContext,
} from './models/operational-context.model';

/**
 * One subject, assembled from records that already exist.
 *
 * Guarded ('admin', 'support') to get in at all, and then EVERY MODULE IS
 * AUTHORIZED SEPARATELY from the caller's own role — see the matrix in the
 * service. Opening one address must not become a way to read something the
 * caller could not read on its own page.
 */
@Resolver()
@UseGuards(GqlAuthGuard, RolesGuard)
export class OperationalContextResolver {
  constructor(private readonly service: OperationalContextService) {}

  @Roles('admin', 'support')
  @Query(() => OperationalContext, { name: 'operationalContext' })
  async operationalContext(
    @Args('subjectType', { type: () => ContextSubjectType })
    subjectType: ContextSubjectType,
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ): Promise<OperationalContext> {
    const role = user.role as unknown as Role | undefined;
    return this.service.build(subjectType, id, role?.roleId ?? '');
  }
}
