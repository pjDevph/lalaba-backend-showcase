import { Resolver, Query, Args, ID, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { ProviderCard } from './models/provider-card.model';
import { ProviderProfile } from './models/provider-profile.model';
import { ProviderServiceItem } from './models/provider-service-item.model';
import { PickupDay } from './models/pickup-slot.model';
import { DiscoverProvidersInput } from './dto/discover-providers.input';
import { ProviderType } from '../online-orders/schemas/order-status.enum';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => ProviderCard)
@Roles('customer')
@UseGuards(GqlAuthGuard, RolesGuard)
export class DiscoveryResolver {
  constructor(private readonly discovery: DiscoveryService) {}

  @Query(() => [ProviderCard], { name: 'discoverProviders' })
  async discoverProviders(
    @Args('filter') filter: DiscoverProvidersInput,
    @CurrentUser() user: User,
  ): Promise<ProviderCard[]> {
    return this.discovery.discoverProviders(user._id, filter);
  }

  // A provider's own public card — the exact card customers see in discovery,
  // for the "this is what customers see" dashboard preview.
  @Roles('washer', 'merchant')
  @Query(() => ProviderCard, { name: 'myProviderCard', nullable: true })
  async myProviderCard(
    @CurrentUser() user: User,
  ): Promise<ProviderCard | null> {
    return this.discovery.myProviderCard(user._id);
  }

  // One public card per branch the caller operates — powers the merchant
  // dashboard's per-branch profile carousel (a washer returns a single card).
  @Roles('washer', 'merchant')
  @Query(() => [ProviderCard], { name: 'myProviderCards' })
  async myProviderCards(@CurrentUser() user: User): Promise<ProviderCard[]> {
    return this.discovery.myProviderCards(user._id);
  }

  // A provider's own full public profile — the exact profile customers see,
  // for the "view as customer" preview.
  @Roles('washer', 'merchant')
  @Query(() => ProviderProfile, { name: 'myProviderProfile', nullable: true })
  async myProviderProfile(
    @CurrentUser() user: User,
  ): Promise<ProviderProfile | null> {
    return this.discovery.myProviderProfile(user._id);
  }

  // Providers may read their OWN public page — that is what "View as customer"
  // shows them. The class default is @Roles('customer'), which this never
  // overrode, so a merchant opening their own preview was rejected outright.
  //
  // Widening is safe: this returns the page any customer can already see, and
  // takes a branchId rather than deriving one from the caller.
  @Roles('customer', 'merchant', 'washer', 'staff')
  @Query(() => ProviderProfile, { name: 'providerProfile' })
  async providerProfile(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
    @CurrentUser() user: User,
  ): Promise<ProviderProfile> {
    return this.discovery.providerProfile(user._id, branchId, providerType);
  }

  // Public service catalog — also used by a provider's own "view as customer"
  // preview, so allow washers/merchants too.
  @Roles('customer', 'washer', 'merchant')
  @Query(() => [ProviderServiceItem], { name: 'providerServices' })
  async providerServices(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
  ): Promise<ProviderServiceItem[]> {
    return this.discovery.providerServices(branchId, providerType);
  }

  /** The customer's pickup-DAY picker. Replaced providerPickupSlots. */
  @Query(() => [PickupDay], { name: 'providerPickupDays' })
  async providerPickupDays(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('fromDate') fromDate: string, // ISO date "2026-08-05"
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
    @Args('days', { type: () => Int, nullable: true }) days?: number,
  ): Promise<PickupDay[]> {
    return this.discovery.providerPickupDays(
      branchId,
      providerType,
      fromDate,
      days ?? 7,
    );
  }
}
