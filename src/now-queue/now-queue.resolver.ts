import { Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { NowQueueService } from './now-queue.service';
import { NowQueue } from './models/work-item.model';

/**
 * What needs someone right now, for the caller's own role.
 *
 * Guarded ('admin', 'support') to ask at all, and each SOURCE is authorized
 * separately from the caller's role inside the service — the same rule the
 * operational context follows, for the same reason: composing several
 * collections behind one query must not become a way around a guard.
 */
@Resolver()
@UseGuards(GqlAuthGuard, RolesGuard)
export class NowQueueResolver {
  constructor(private readonly service: NowQueueService) {}

  @Roles('admin', 'support')
  @Query(() => NowQueue, { name: 'nowQueue' })
  async nowQueue(@CurrentUser() user: User): Promise<NowQueue> {
    const role = user.role as unknown as Role | undefined;
    return this.service.build(role?.roleId ?? '');
  }
}
