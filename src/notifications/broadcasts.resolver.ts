import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { BroadcastsService } from './broadcasts.service';
import { Broadcast } from './schemas/broadcast.schema';
import { SendBroadcastInput } from './dto/send-broadcast.input';
import {
  BroadcastPreview,
  PaginatedBroadcasts,
} from './models/broadcast-preview.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';

/**
 * Admin-only, unlike most operations surfaces.
 *
 * A push reaches every customer's lock screen and cannot be recalled. That is
 * a bigger blast radius than anything else in the panel, including suspending
 * a provider — so it sits with whoever owns the platform's voice, not with
 * whoever is answering tickets today.
 */
@Resolver(() => Broadcast)
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class BroadcastsResolver {
  constructor(
    private readonly broadcasts: BroadcastsService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  /** How many this would reach. Always call before sending. */
  @Query(() => BroadcastPreview, { name: 'broadcastPreview' })
  async broadcastPreview(
    @Args('audienceRoleIds', { type: () => [String] })
    audienceRoleIds: string[],
    @Args('includeInactive', { type: () => Boolean, nullable: true })
    includeInactive: boolean | null,
  ): Promise<BroadcastPreview> {
    return this.broadcasts.preview(audienceRoleIds, includeInactive ?? false);
  }

  @Query(() => PaginatedBroadcasts, { name: 'broadcastHistory' })
  async broadcastHistory(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 25 })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number,
  ): Promise<PaginatedBroadcasts> {
    return this.broadcasts.history(limit, offset);
  }

  @Mutation(() => Broadcast)
  async sendBroadcast(
    @Args('input') input: SendBroadcastInput,
    @CurrentUser() actor: User,
  ): Promise<Broadcast> {
    const broadcast = await this.broadcasts.send(input, actor);
    await this.adminAudit.record({
      action: AdminAuditAction.BROADCAST_SENT,
      actor,
      targetType: AdminAuditTargetType.BROADCAST,
      targetId: String(broadcast._id),
      targetLabel: broadcast.title,
      details: {
        audience: broadcast.audienceRoleIds.join(', '),
        audienceCount: broadcast.audienceCount,
        tokenCount: broadcast.tokenCount,
        status: broadcast.status,
      },
    });
    return broadcast;
  }
}
