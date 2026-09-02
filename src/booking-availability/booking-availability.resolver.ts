import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import {
  BadRequestException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BookingAvailabilityService } from './booking-availability.service';
import { BookingAvailabilityConfig } from './schemas/booking-availability-config.schema';
import { BookingDateOverride } from './schemas/booking-date-override.schema';
import { BookingBlackout } from './schemas/booking-blackout.schema';
import {
  BookingDayAvailability,
  BookingProviderRow,
  BookingRulesSummary,
  UpcomingSpecialDate,
} from './models/booking-availability.models';
import {
  CopyBookingDayInput,
  CreateBookingBlackoutInput,
  UpdateBookingAvailabilityInput,
  UpdateFulfillmentPricingInput,
  UpdateMyBookingCapacityInput,
  UpsertBookingDateOverrideInput,
} from './dto/booking-availability.input';
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
 * Booking Availability API.
 *
 * Three audiences, three access levels:
 *   Admin     — full read/write on any provider (the Booking Availability page).
 *   Provider  — reads her own config; writes only capacity + the pause switch.
 *   Customer  — reads resolved availability (calendar/slots) for any provider,
 *               and never the config document itself. Capacity ceilings and
 *               pause reasons are the provider's business.
 */
@Resolver(() => BookingAvailabilityConfig)
@UseGuards(GqlAuthGuard, RolesGuard)
export class BookingAvailabilityResolver {
  constructor(
    private readonly service: BookingAvailabilityService,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
  ) {}

  // ── Admin ────────────────────────────────────────────────────────────────

  /**
   * The provider directory. Read-only, and the one admin query support also
   * holds: "is this washer live, and what is her cap?" is a question a support
   * agent is asked on the call they are already on, and every answer here is
   * already visible to the customer choosing a provider. Everything that
   * WRITES below stays admin-only.
   */
  @Roles('admin', 'support')
  @Query(() => [BookingProviderRow], { name: 'bookingProviders' })
  async bookingProviders(): Promise<BookingProviderRow[]> {
    return this.service.listProviders();
  }

  /**
   * Read-only, and support holds it for the same reason it holds
   * bookingProviders: "why can't I book her on the 25th?" is a question that
   * arrives on a call, and the answer is this document plus the special dates
   * below. Every mutation on this resolver stays admin-only.
   */
  @Roles('admin', 'support')
  @Query(() => BookingAvailabilityConfig, { name: 'bookingAvailability' })
  async bookingAvailability(
    @Args('branchId', { type: () => ID }) branchId: string,
  ): Promise<BookingAvailabilityConfig> {
    const providerType = await this.resolveProviderType(branchId);
    return this.service.getOrCreateConfig(branchId, providerType);
  }

  @Roles('admin')
  @Mutation(() => BookingAvailabilityConfig)
  async updateBookingAvailability(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('input') input: UpdateBookingAvailabilityInput,
    @CurrentUser() user: User,
  ): Promise<BookingAvailabilityConfig> {
    const providerType = await this.resolveProviderType(branchId);
    return this.service.updateConfig(branchId, providerType, input, user._id);
  }

  @Roles('admin')
  @Mutation(() => BookingAvailabilityConfig)
  async copyBookingDay(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('input') input: CopyBookingDayInput,
  ): Promise<BookingAvailabilityConfig> {
    const providerType = await this.resolveProviderType(branchId);
    return this.service.copyDay(branchId, providerType, input);
  }

  @Roles('admin')
  @Mutation(() => BookingDateOverride)
  async upsertBookingDateOverride(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('input') input: UpsertBookingDateOverrideInput,
    @CurrentUser() user: User,
  ): Promise<BookingDateOverride> {
    await this.resolveProviderType(branchId);
    return this.service.upsertOverride(branchId, input, user._id);
  }

  @Roles('admin')
  @Mutation(() => Boolean)
  async removeBookingDateOverride(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('date') date: string,
  ): Promise<boolean> {
    return this.service.removeOverride(branchId, date);
  }

  @Roles('admin')
  @Mutation(() => BookingBlackout)
  async createBookingBlackout(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('input') input: CreateBookingBlackoutInput,
    @CurrentUser() user: User,
  ): Promise<BookingBlackout> {
    await this.resolveProviderType(branchId);
    return this.service.createBlackout(branchId, input, user._id);
  }

  @Roles('admin')
  @Mutation(() => Boolean)
  async removeBookingBlackout(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.service.removeBlackout(branchId, id);
  }

  /** Read-only — see bookingAvailability above. */
  @Roles('admin', 'support')
  @Query(() => [UpcomingSpecialDate], { name: 'bookingSpecialDates' })
  async bookingSpecialDates(
    @Args('branchId', { type: () => ID }) branchId: string,
  ): Promise<UpcomingSpecialDate[]> {
    return this.service.upcomingSpecialDates(branchId);
  }

  // ── Provider (partner app) ───────────────────────────────────────────────

  /**
   * The caller's own config. Read-only for everything except capacity and the
   * pause switch — see updateMyBookingCapacity.
   */
  @Roles('washer', 'merchant', 'admin')
  @Query(() => BookingAvailabilityConfig, { name: 'myBookingAvailability' })
  async myBookingAvailability(
    @CurrentUser() user: User,
    @Args('branchId', { type: () => ID, nullable: true }) branchId?: string,
  ): Promise<BookingAvailabilityConfig> {
    const own = await this.resolveOwnProvider(user._id, branchId);
    return this.service.getOrCreateConfig(own.branchId, own.providerType);
  }

  @Roles('washer', 'merchant')
  @Mutation(() => BookingAvailabilityConfig)
  async updateMyBookingCapacity(
    @Args('input') input: UpdateMyBookingCapacityInput,
    @CurrentUser() user: User,
    @Args('branchId', { type: () => ID, nullable: true }) branchId?: string,
  ): Promise<BookingAvailabilityConfig> {
    const own = await this.resolveOwnProvider(user._id, branchId);
    return this.service.updateOwnCapacity(
      own.branchId,
      own.providerType,
      input,
    );
  }

  /**
   * A provider prices their own fulfillment legs. Admin can too, via branchId —
   * the same shape as every other self-serve mutation here, so support can fix
   * a provider's pricing without a separate admin surface.
   */
  @Roles('washer', 'merchant', 'admin')
  @Mutation(() => BookingAvailabilityConfig)
  async updateMyFulfillmentPricing(
    @Args('input') input: UpdateFulfillmentPricingInput,
    @CurrentUser() user: User,
    @Args('branchId', { type: () => ID, nullable: true }) branchId?: string,
  ): Promise<BookingAvailabilityConfig> {
    const own = await this.resolveOwnProvider(user._id, branchId);
    return this.service.updateFulfillmentPricing(
      own.branchId,
      own.providerType,
      input,
    );
  }

  @Roles('washer', 'merchant', 'admin')
  @Query(() => [UpcomingSpecialDate], { name: 'myBookingSpecialDates' })
  async myBookingSpecialDates(
    @CurrentUser() user: User,
    @Args('branchId', { type: () => ID, nullable: true }) branchId?: string,
  ): Promise<UpcomingSpecialDate[]> {
    const own = await this.resolveOwnProvider(user._id, branchId);
    return this.service.upcomingSpecialDates(own.branchId);
  }

  // ── Shared reads: resolved availability ──────────────────────────────────

  /**
   * §14 preview / customer date picker. Open to any authenticated caller
   * because it exposes only what a customer would see anyway — bookable or
   * not, and how many slots remain.
   */
  @Query(() => [BookingDayAvailability], { name: 'providerBookingCalendar' })
  async providerBookingCalendar(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
    @Args('fromDate', { nullable: true }) fromDate?: string,
    @Args('days', { type: () => Int, nullable: true }) days?: number,
  ): Promise<BookingDayAvailability[]> {
    return this.service.calendar(branchId, providerType, fromDate, days);
  }

  @Query(() => BookingDayAvailability, { name: 'providerBookingDay' })
  async providerBookingDay(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
    @Args('date') date: string,
  ): Promise<BookingDayAvailability> {
    return this.service.dayAvailability(branchId, providerType, date);
  }

  // ── Computed fields ──────────────────────────────────────────────────────

  /**
   * §15 — the rules in plain language, resolved against the CURRENT platform
   * entitlement, so a live campaign shows up here without anything having been
   * written to this provider's record.
   */
  @ResolveField(() => BookingRulesSummary, { name: 'summary' })
  async summary(
    @Parent() config: BookingAvailabilityConfig,
  ): Promise<BookingRulesSummary> {
    return this.service.summary(config);
  }

  // ── Provider resolution ──────────────────────────────────────────────────

  /**
   * A washer's config is keyed by her branchId anchor, so both provider types
   * resolve to the same key space. Checking the washer collection first is what
   * makes that anchor branch — which exists only to satisfy shared FKs — resolve
   * as WASHER rather than as a laundromat.
   */
  private async resolveProviderType(branchId: string): Promise<ProviderType> {
    const washer = await this.washerModel
      .findOne({ branchId })
      .select('_id')
      .exec();
    if (washer) return ProviderType.WASHER;

    const branch = await this.branchModel
      .findById(branchId)
      .select('_id')
      .exec();
    if (!branch) throw new NotFoundException('Provider not found');
    return ProviderType.MERCHANT;
  }

  /**
   * Resolves the caller's own provider, optionally narrowed to one of their
   * branches. `requestedBranchId` is verified against ownership rather than
   * trusted — otherwise any merchant could read or pause a competitor's
   * bookings by passing their branch id.
   */
  private async resolveOwnProvider(
    uid: string,
    requestedBranchId?: string,
  ): Promise<{ branchId: string; providerType: ProviderType }> {
    const washer = await this.washerModel
      .findOne({ uid })
      .select('branchId')
      .exec();
    if (washer) {
      if (requestedBranchId && requestedBranchId !== washer.branchId) {
        throw new BadRequestException('That branch is not yours.');
      }
      return { branchId: washer.branchId, providerType: ProviderType.WASHER };
    }

    const branches = await this.branchModel.find({ uid }).select('_id').exec();
    if (branches.length === 0) {
      throw new BadRequestException(
        'You do not have a provider profile to configure bookings for.',
      );
    }

    if (requestedBranchId) {
      const owned = branches.some((b) => String(b._id) === requestedBranchId);
      if (!owned) throw new BadRequestException('That branch is not yours.');
      return {
        branchId: requestedBranchId,
        providerType: ProviderType.MERCHANT,
      };
    }

    // No branch named: a single-branch merchant has exactly one answer, and a
    // multi-branch merchant's app always passes the picker's selection.
    return {
      branchId: String(branches[0]._id),
      providerType: ProviderType.MERCHANT,
    };
  }
}
