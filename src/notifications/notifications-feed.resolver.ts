import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, Int, ID } from '@nestjs/graphql';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import { User } from '../users/schemas/user.schema';
import { NotificationsFeedService } from './notifications-feed.service';
import { PaginatedNotifications } from './models/notification-item.model';
import { NotificationFilterInput } from './dto/notification-filter.input';

/**
 * The in-app notification inbox.
 *
 * Guarded with GqlAuthGuard alone, deliberately:
 *
 * - No @Roles. Every role has a feed, including customers and couriers.
 * - No @RequirePermissions. Couriers, washers and customers hold no
 *   permissions at all, so any permission gate here would lock them out
 *   entirely. Per-row permission filtering happens inside the service instead,
 *   where it can hide rows rather than reject the call.
 * - No @AllowUnregisteredDevice. Unlike saveFcmToken, which must work before a
 *   staff device is approved, the inbox must NOT: an unapproved device sitting
 *   in a shop should not be able to read the branch's notifications.
 */
@Resolver()
@UseGuards(GqlAuthGuard)
export class NotificationsFeedResolver {
  constructor(private readonly feed: NotificationsFeedService) {}

  @Query(() => PaginatedNotifications, { name: 'myNotifications' })
  async myNotifications(
    @CurrentUser() user: User,
    @Args('limit', { type: () => Int, defaultValue: 20 }) limit: number,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset: number,
    @ActiveBranch() activeBranchId?: string | null,
    @Args('filter', { type: () => NotificationFilterInput, nullable: true })
    filter?: NotificationFilterInput,
  ): Promise<PaginatedNotifications> {
    // Same cap as listUsers and the other paged queries — a client asking for
    // 10,000 rows is a bug or an attack, never a real inbox.
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return this.feed.myNotifications(
      user,
      safeLimit,
      Math.max(offset, 0),
      filter,
      activeBranchId,
    );
  }

  /** Badge count. Capped at 99 — see UNREAD_COUNT_CAP. */
  @Query(() => Int, { name: 'myUnreadNotificationCount' })
  async myUnreadNotificationCount(
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<number> {
    return this.feed.myUnreadNotificationCount(user, activeBranchId);
  }

  @Mutation(() => Boolean)
  async markNotificationRead(
    @CurrentUser() user: User,
    @Args('id', { type: () => ID }) id: string,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<boolean> {
    return this.feed.markNotificationRead(user, id, activeBranchId);
  }

  @Mutation(() => Boolean)
  async markAllNotificationsRead(@CurrentUser() user: User): Promise<boolean> {
    return this.feed.markAllNotificationsRead(user);
  }
}
