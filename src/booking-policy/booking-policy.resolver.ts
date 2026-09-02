import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Float,
} from '@nestjs/graphql';
import { BadRequestException, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BookingPolicyService } from './booking-policy.service';
import { BookingPolicy } from './schemas/booking-policy.schema';
import { BookingMilestone } from './schemas/booking-milestone.schema';
import {
  BookingCampaign,
  CampaignScope,
} from './schemas/booking-campaign.schema';
import {
  CampaignImpact,
  EffectiveEntitlementModel,
  MilestoneProgress,
  PolicySimulation,
} from './models/booking-policy.models';
import {
  PublishBookingPolicyInput,
  SimulatePolicyInput,
  UpsertBookingCampaignInput,
  UpsertBookingMilestoneInput,
} from './dto/booking-policy.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { ProviderType } from '../online-orders/schemas/order-status.enum';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';

/**
 * Booking Policy API.
 *
 * Admin reads and writes ONE policy, a handful of milestones and a handful of
 * campaigns — never a provider record. A provider reads what she is currently
 * entitled to and how far she is from the next tier.
 */
@Resolver(() => BookingPolicy)
@UseGuards(GqlAuthGuard, RolesGuard)
export class BookingPolicyResolver {
  constructor(
    private readonly service: BookingPolicyService,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
  ) {}

  // ── Policy ───────────────────────────────────────────────────────────────

  @Roles('admin')
  @Query(() => BookingPolicy, { name: 'bookingPolicy' })
  async bookingPolicy(): Promise<BookingPolicy> {
    return this.service.current();
  }

  @Roles('admin')
  @Query(() => [BookingPolicy], { name: 'bookingPolicyHistory' })
  async bookingPolicyHistory(
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<BookingPolicy[]> {
    return this.service.history(limit ?? 20);
  }

  @Roles('admin')
  @Mutation(() => BookingPolicy)
  async publishBookingPolicy(
    @Args('input') input: PublishBookingPolicyInput,
    @CurrentUser() user: User,
  ): Promise<BookingPolicy> {
    return this.service.publish(input, user._id);
  }

  /**
   * The one number the washer app's radius picker needs — not the whole
   * admin-only policy document, just the ceiling it must not let her exceed.
   */
  @Roles('admin', 'support', 'washer', 'merchant')
  @Query(() => Float, { name: 'maxServiceRadiusKm' })
  async maxServiceRadiusKm(): Promise<number> {
    const policy = await this.service.current();
    return policy.safetyLimits.maxServiceRadiusKm;
  }

  // ── Milestones ───────────────────────────────────────────────────────────

  @Roles('admin', 'washer', 'merchant')
  @Query(() => [BookingMilestone], { name: 'bookingMilestones' })
  async bookingMilestones(): Promise<BookingMilestone[]> {
    // Readable by providers too: the partner app shows the whole ladder so a
    // washer can see what the next tier is worth, not just that it exists.
    return this.service.listMilestones();
  }

  @Roles('admin')
  @Mutation(() => BookingMilestone)
  async upsertBookingMilestone(
    @Args('input') input: UpsertBookingMilestoneInput,
    @CurrentUser() user: User,
  ): Promise<BookingMilestone> {
    return this.service.upsertMilestone(input, user._id);
  }

  @Roles('admin')
  @Mutation(() => Boolean)
  async removeBookingMilestone(@Args('key') key: string): Promise<boolean> {
    return this.service.removeMilestone(key);
  }

  // ── Campaigns ────────────────────────────────────────────────────────────

  @Roles('admin')
  @Query(() => [BookingCampaign], { name: 'bookingCampaigns' })
  async bookingCampaigns(): Promise<BookingCampaign[]> {
    return this.service.listCampaigns();
  }

  @Roles('admin')
  @Mutation(() => BookingCampaign)
  async upsertBookingCampaign(
    @Args('input') input: UpsertBookingCampaignInput,
    @CurrentUser() user: User,
  ): Promise<BookingCampaign> {
    return this.service.upsertCampaign(input, user._id);
  }

  @Roles('admin')
  @Mutation(() => Boolean)
  async removeBookingCampaign(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.service.removeCampaign(id);
  }

  /** The pre-publish "how many providers does this reach" count. */
  @Roles('admin')
  @Query(() => CampaignImpact, { name: 'bookingCampaignImpact' })
  async bookingCampaignImpact(
    @Args('scope', { type: () => CampaignScope }) scope: CampaignScope,
    @Args('providerType', { type: () => ProviderType, nullable: true })
    providerType?: ProviderType,
    @Args('milestoneKeys', { type: () => [String], nullable: true })
    milestoneKeys?: string[],
  ): Promise<CampaignImpact> {
    return this.service.campaignImpact({ scope, providerType, milestoneKeys });
  }

  // ── Simulator ────────────────────────────────────────────────────────────

  @Roles('admin')
  @Query(() => PolicySimulation, { name: 'simulateBookingPolicy' })
  async simulateBookingPolicy(
    @Args('input') input: SimulatePolicyInput,
  ): Promise<PolicySimulation> {
    return this.service.simulate(input);
  }

  // ── Provider-facing ──────────────────────────────────────────────────────

  /** What the caller is entitled to today — computed, never stored. */
  @Roles('washer', 'merchant', 'admin')
  @Query(() => EffectiveEntitlementModel, { name: 'myBookingEntitlement' })
  async myBookingEntitlement(
    @CurrentUser() user: User,
    @Args('date', { nullable: true }) date?: string,
  ): Promise<EffectiveEntitlementModel> {
    const own = await this.resolveOwnProvider(user._id);
    return this.service.entitlementFor(own.branchId, own.providerType, date);
  }

  @Roles('washer', 'admin')
  @Query(() => MilestoneProgress, {
    name: 'myMilestoneProgress',
    nullable: true,
  })
  async myMilestoneProgress(
    @CurrentUser() user: User,
  ): Promise<MilestoneProgress | null> {
    const own = await this.resolveOwnProvider(user._id);
    return this.service.progressFor(own.branchId, own.providerType);
  }

  /** Admin/support view of one provider's computed entitlement. */
  @Roles('admin')
  @Query(() => EffectiveEntitlementModel, {
    name: 'providerBookingEntitlement',
  })
  async providerBookingEntitlement(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
    @Args('date', { nullable: true }) date?: string,
  ): Promise<EffectiveEntitlementModel> {
    return this.service.entitlementFor(branchId, providerType, date);
  }

  private async resolveOwnProvider(
    uid: string,
  ): Promise<{ branchId: string; providerType: ProviderType }> {
    const washer = await this.washerModel
      .findOne({ uid })
      .select('branchId')
      .exec();
    if (washer) {
      return { branchId: washer.branchId, providerType: ProviderType.WASHER };
    }

    const branch = await this.branchModel.findOne({ uid }).select('_id').exec();
    if (!branch) {
      throw new BadRequestException('You do not have a provider profile.');
    }
    return {
      branchId: String(branch._id),
      providerType: ProviderType.MERCHANT,
    };
  }
}
