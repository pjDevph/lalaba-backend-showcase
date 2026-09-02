import { Resolver, Query, Mutation, Args, ID, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { RatingsService } from './ratings.service';
import { Rating } from './schemas/rating.schema';
import { PaginatedRatings } from './models/paginated-ratings.model';
import { SubmitRatingInput } from './dto/submit-rating.input';
import { UpdateRatingInput } from './dto/update-rating.input';
import { RatingFilterInput } from './dto/rating-filter.input';
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

const PROVIDER_ROLES = ['merchant', 'washer'];

@Resolver(() => Rating)
@UseGuards(GqlAuthGuard, RolesGuard)
export class RatingsResolver {
  constructor(
    private readonly ratingsService: RatingsService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Roles('customer')
  @Mutation(() => Rating)
  async submitRating(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: SubmitRatingInput,
    @CurrentUser() customer: User,
  ) {
    return this.ratingsService.submitRating(orderId, customer, input);
  }

  @Roles('customer')
  @Mutation(() => Rating)
  async updateRating(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: UpdateRatingInput,
    @CurrentUser() customer: User,
  ) {
    return this.ratingsService.updateRating(orderId, customer, input);
  }

  @Roles('customer')
  @Query(() => Rating, { name: 'myRatingForOrder', nullable: true })
  async myRatingForOrder(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() customer: User,
  ) {
    return this.ratingsService.myRatingForOrder(orderId, customer);
  }

  @Roles('customer', ...PROVIDER_ROLES)
  @Mutation(() => Rating)
  async reportRating(
    @Args('ratingId', { type: () => ID }) ratingId: string,
    @Args('reason') reason: string,
  ) {
    return this.ratingsService.reportRating(ratingId, reason);
  }

  @Roles('admin', 'support')
  @Mutation(() => Rating)
  async moderateTakedown(
    @Args('ratingId', { type: () => ID }) ratingId: string,
    @Args('reason') reason: string,
    @CurrentUser() actor: User,
  ) {
    const rating = await this.ratingsService.moderateTakedown(ratingId, reason);
    await this.adminAudit.record({
      action: AdminAuditAction.REVIEW_REMOVED,
      actor,
      targetType: AdminAuditTargetType.REVIEW,
      targetId: ratingId,
      targetLabel: `Order ${rating.orderId}`,
      reasonCode: reason,
    });
    return rating;
  }

  /**
   * Put a removed review back. The counterpart takedown never had — without
   * it a moderation mistake is permanent.
   */
  @Roles('admin', 'support')
  @Mutation(() => Rating)
  async restoreRating(
    @Args('ratingId', { type: () => ID }) ratingId: string,
    @Args('reason') reason: string,
    @CurrentUser() actor: User,
  ) {
    const rating = await this.ratingsService.restoreRating(ratingId, reason);
    await this.adminAudit.record({
      action: AdminAuditAction.REVIEW_RESTORED,
      actor,
      targetType: AdminAuditTargetType.REVIEW,
      targetId: ratingId,
      targetLabel: `Order ${rating.orderId}`,
      reasonCode: reason,
    });
    return rating;
  }

  /**
   * Clear a report without removing the review — the queue's other exit.
   * Not audited to the platform trail: leaving a review up is the default
   * outcome, not an action taken against anyone.
   */
  @Roles('admin', 'support')
  @Mutation(() => Rating)
  async dismissRatingReport(
    @Args('ratingId', { type: () => ID }) ratingId: string,
    @Args('reason') reason: string,
  ) {
    return this.ratingsService.dismissReport(ratingId, reason);
  }

  /** Platform-wide moderation queue — reported and removed reviews. */
  @Roles('admin', 'support')
  @Query(() => PaginatedRatings, { name: 'ratingModerationQueue' })
  async ratingModerationQueue(
    @Args('reported', { type: () => Boolean, nullable: true })
    reported: boolean | null,
    @Args('removed', { type: () => Boolean, nullable: true })
    removed: boolean | null,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 25 })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number,
  ) {
    return this.ratingsService.moderationQueue({
      reported: reported ?? undefined,
      removed: removed ?? undefined,
      limit,
      offset,
    });
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => Rating)
  async respondToReview(
    @Args('ratingId', { type: () => ID }) ratingId: string,
    @Args('text') text: string,
    @CurrentUser() provider: User,
  ) {
    return this.ratingsService.respondToReview(ratingId, provider, text);
  }

  @Roles('customer', ...PROVIDER_ROLES, 'admin', 'support')
  @Query(() => PaginatedRatings, { name: 'shopRatings' })
  async shopRatings(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('filter', { type: () => RatingFilterInput, nullable: true })
    filter: RatingFilterInput,
  ) {
    return this.ratingsService.shopRatings(branchId, filter);
  }
}
