import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { NotFoundException, UseGuards } from '@nestjs/common';
import { PromotionsService } from '../promotions/promotions.service';
import { UserVoucherView } from '../promotions/models/user-voucher.model';
import { CampaignsService } from './campaigns.service';
import { Campaign } from './schemas/campaign.schema';
import { CreateCampaignInput } from './dto/create-campaign.input';
import { UpdateCampaignInput } from './dto/update-campaign.input';
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
 * Admin authoring. Creating and editing campaigns is an admin-only act — the
 * whole surface is behind `@Roles('admin')` at class level, so a new mutation
 * added here is admin-only by default rather than by remembering.
 */
@Resolver(() => Campaign)
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class CampaignsAdminResolver {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Query(() => [Campaign], { name: 'campaigns' })
  async list(): Promise<Campaign[]> {
    return this.campaigns.findAll();
  }

  @Query(() => Campaign, { name: 'campaign' })
  async one(@Args('id', { type: () => ID }) id: string): Promise<Campaign> {
    return this.campaigns.findOne(id);
  }

  @Mutation(() => Campaign)
  async createCampaign(
    @Args('input') input: CreateCampaignInput,
    @CurrentUser() actor: User,
  ): Promise<Campaign> {
    const actorName =
      `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() ||
      (actor.email ?? actor._id);
    const created = await this.campaigns.create(input, actor._id, actorName);
    await this.adminAudit.record({
      action: AdminAuditAction.CAMPAIGN_CREATED,
      actor,
      targetType: AdminAuditTargetType.CAMPAIGN,
      targetId: String(created._id),
      targetLabel: created.name,
    });
    return created;
  }

  @Mutation(() => Campaign)
  async updateCampaign(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCampaignInput,
    @CurrentUser() actor: User,
  ): Promise<Campaign> {
    const updated = await this.campaigns.update(id, input);
    await this.adminAudit.record({
      action: AdminAuditAction.CAMPAIGN_UPDATED,
      actor,
      targetType: AdminAuditTargetType.CAMPAIGN,
      targetId: String(updated._id),
      targetLabel: updated.name,
    });
    return updated;
  }
}

/**
 * Delivery, for the apps.
 *
 * Any authenticated account may ask — but only ever about ITSELF. There is no
 * role or audience argument: both come from the authenticated identity inside
 * the service. An app that could name its own audience could show itself a
 * partner-only incentive, which is a disclosure rather than a wrong picture.
 */
@Resolver(() => Campaign)
@UseGuards(GqlAuthGuard)
export class CampaignsDeliveryResolver {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly promotions: PromotionsService,
  ) {}

  /**
   * At most one campaign, highest priority first. Null when nothing is due —
   * which is the normal answer most of the time.
   */
  @Query(() => Campaign, { name: 'nextCampaign', nullable: true })
  async next(
    @CurrentUser() user: User,
    @Args('sessionId', { type: () => String, nullable: true })
    sessionId?: string,
  ): Promise<Campaign | null> {
    return this.campaigns.nextFor(user, sessionId);
  }

  /**
   * Take the offer a campaign is advertising.
   *
   * Returns the held voucher. Idempotent all the way down — a double tap
   * yields the same entitlement, because the uniqueness is a database index
   * rather than a disabled button.
   *
   * Claiming grants no money: the voucher still goes through the same
   * validation at checkout as a typed code, so caps, minimums and expiry all
   * still apply when it is actually used.
   */
  @Mutation(() => UserVoucherView)
  async claimCampaignOffer(
    @Args('campaignId', { type: () => ID }) campaignId: string,
    @CurrentUser() user: User,
  ): Promise<UserVoucherView> {
    const promoId = await this.campaigns.claimablePromoId(campaignId, user);
    await this.promotions.claim(promoId, user._id);
    void this.campaigns.recordInteraction(campaignId, user._id, 'CLICKED');
    // Read it back through the same view the list uses, so a freshly claimed
    // voucher and a listed one can never describe themselves differently.
    const held = await this.promotions.vouchersFor(user._id);
    const claimed = held.find((v) => v.promoId === promoId);
    if (!claimed) throw new NotFoundException('Voucher could not be read back');
    return claimed;
  }

  @Mutation(() => Boolean)
  async markCampaignClicked(
    @Args('campaignId', { type: () => ID }) campaignId: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.campaigns.recordInteraction(campaignId, user._id, 'CLICKED');
  }

  @Mutation(() => Boolean)
  async markCampaignDismissed(
    @Args('campaignId', { type: () => ID }) campaignId: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.campaigns.recordInteraction(campaignId, user._id, 'DISMISSED');
  }
}
