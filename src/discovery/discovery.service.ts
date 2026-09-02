import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
  WasherStatus,
} from '../washer/schemas/washer-profile.schema';
import { washerStoreName } from '../washer/washer-name.util';
import {
  Service,
  ServiceDocument,
  PricingType,
} from '../services/schemas/service.schema';
import {
  WasherServiceTemplate,
  WasherServiceTemplateDocument,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { Rating, RatingDocument } from '../ratings/schemas/rating.schema';
import {
  Favorite,
  FavoriteDocument,
} from '../favorites/schemas/favorite.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { DISCOVERY_ACCEPT_MIN_CENTAVOS } from '../wallets/wallet.constants';
import { PlatformFeeService } from '../platform-fee/platform-fee.service';
import { WasherServiceOfferingsService } from '../washer-service-offerings/washer-service-offerings.service';
import {
  comparableInDiscovery,
  DISCOVERY_REFERENCE_WEIGHT_KG,
} from '../washer-service-offerings/washer-pricing.util';
import { calculateServiceLineTotal } from '../online-orders/pricing.util';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  ProviderType,
  CAP_COUNTED_STATUSES,
} from '../online-orders/schemas/order-status.enum';
import {
  DeliverySubMode,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
} from '../online-orders/schemas/order-status.enum';
import { OperatingHours } from '../branches/schemas/sub-documents.schema';
import { ProviderCard } from './models/provider-card.model';
import {
  ProviderProfile,
  RatingHistogramBucket,
} from './models/provider-profile.model';
import { ProviderServiceItem } from './models/provider-service-item.model';
import { PickupDay } from './models/pickup-slot.model';
import { BookingAvailabilityService } from '../booking-availability/booking-availability.service';
import { BookingPolicyService } from '../booking-policy/booking-policy.service';
import { isBookingAccepting } from '../booking-availability/availability-resolution.util';
import { pickupFeeCentavosFor } from '../online-orders/fulfillment-pricing.util';
import {
  dayLabel,
  phDayKey,
  startOfTodayPH,
} from '../common/utils/ph-time.util';
import { explainUnavailable } from '../booking-availability/models/booking-availability.models';
import {
  DiscoverProvidersInput,
  ProviderSort,
  ProviderTypeFilter,
} from './dto/discover-providers.input';

const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

@Injectable()
export class DiscoveryService {
  constructor(
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(Service.name)
    private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(WasherServiceTemplate.name)
    private readonly templateModel: Model<WasherServiceTemplateDocument>,
    @InjectModel(Rating.name)
    private readonly ratingModel: Model<RatingDocument>,
    @InjectModel(Favorite.name)
    private readonly favoriteModel: Model<FavoriteDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    private readonly platformFeeService: PlatformFeeService,
    private readonly washerOfferingsService: WasherServiceOfferingsService,
    private readonly bookingAvailability: BookingAvailabilityService,
    private readonly bookingPolicy: BookingPolicyService,
  ) {}

  // The platform fee is baked into every price the CUSTOMER sees — it is never
  // shown as a separate line. Providers configure a base rate; customers see
  // base × (1 + fee%). This markup is applied at this (customer-facing) layer so
  // the price on a card/service row equals the price used in the estimate.
  private markup(centavos: number, feePercent: number): number {
    return Math.round(centavos * (1 + feePercent / 100));
  }
  private markupOpt(
    centavos: number | undefined | null,
    feePercent: number,
  ): number | undefined {
    return centavos == null ? undefined : this.markup(centavos, feePercent);
  }

  /**
   * Marks a mixed list of cards up, each at its OWN provider type's commission
   * rate. Every caller previously resolved one rate and applied it to the whole
   * list, which was correct only while washers and merchants shared a rate —
   * the fee rules now let those diverge, and the day an admin sets the
   * laundromat rate to 8% a single-rate loop starts showing merchants at the
   * washer price. Both rates are resolved once per call, not once per card.
   */
  private async applyFeeMarkup(cards: ProviderCard[]): Promise<void> {
    if (!cards.length) return;
    const [washerFee, merchantFee] = await Promise.all([
      this.platformFeeService.getCommissionPercent(ProviderType.WASHER),
      this.platformFeeService.getCommissionPercent(ProviderType.MERCHANT),
    ]);
    for (const c of cards) {
      c.priceFromCentavos = this.markupOpt(
        c.priceFromCentavos,
        c.providerType === ProviderType.WASHER ? washerFee : merchantFee,
      );
    }
  }

  // A provider is only listed once its fee wallet is activated (₱1,000 onboarding
  // top-up) AND holds at least the ₱100 accept-a-booking minimum.
  // Centralized in wallet.constants.ts (GAP-M-022 / DECISION_REQUIRED-002).
  private static readonly ACCEPT_MIN_CENTAVOS = DISCOVERY_ACCEPT_MIN_CENTAVOS;

  // ...and once it has something to sell. A funded provider with an empty
  // catalog lists as a card with no service chips, no "from" price and a
  // Services tab that is blank — a customer can open it and has nothing to
  // book. Both card builders already resolve the catalog (merchant: active,
  // non-archived Services on the branch; washer: active ServiceTemplates it
  // opted into), so this reuses that result rather than querying again.
  private hasSellableCatalog(card: ProviderCard): boolean {
    return (card.serviceCategories?.length ?? 0) > 0;
  }
  // Verification badges reflect the real trust state (verifiedAt), so the card
  // "Unverified" shield and the profile "VERIFIED BUSINESS / HOME WASHER" pill
  // never disagree.
  private merchantBadges(verified: boolean): string[] {
    return verified ? ['LAUNDROMAT', 'VERIFIED_BUSINESS'] : ['LAUNDROMAT'];
  }
  private washerBadges(verified: boolean): string[] {
    return verified ? ['VERIFIED_HOME_WASHER'] : ['HOME_WASHER'];
  }

  private walletVisible(wallet?: WalletDocument | null): boolean {
    return (
      !!wallet &&
      wallet.activatedAt != null &&
      wallet.balanceCentavos >= DiscoveryService.ACCEPT_MIN_CENTAVOS
    );
  }
  private async visibleBranchIds(branchIds: string[]): Promise<Set<string>> {
    if (branchIds.length === 0) return new Set();
    const wallets = await this.walletModel
      .find({ branchId: { $in: branchIds } })
      .exec();
    const visible = new Set<string>();
    for (const w of wallets) if (this.walletVisible(w)) visible.add(w.branchId);
    return visible;
  }

  // Home washer's operator (owner) name — "Operated by: …" on the card. The
  // washer's `uid` is the owner User; returns undefined if it can't resolve.
  private async operatorNameFor(uid: string): Promise<string | undefined> {
    if (!uid) return undefined;
    const owner = await this.userModel
      .findById(uid)
      .select('firstName lastName')
      .lean()
      .exec();
    if (!owner) return undefined;
    const name = `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim();
    return name || undefined;
  }

  // ---------------------------------------------------------------------------
  // discoverProviders — federates online merchant Branches and active
  // WasherProfiles (wallet-funded per the canonical payment-readiness rule;
  // KYC only drives the Verified/Unverified badge) into one ranked card list.
  // ---------------------------------------------------------------------------
  async discoverProviders(
    uid: string,
    filter: DiscoverProvidersInput,
  ): Promise<ProviderCard[]> {
    const {
      latitude,
      longitude,
      radiusKm = 15,
      providerType = ProviderTypeFilter.ALL,
      category,
      search,
      minRating,
      openNow,
      sort = ProviderSort.NEAREST,
      limit = 30,
    } = filter;

    const wantMerchant = providerType !== ProviderTypeFilter.WASHER;
    const wantWasher = providerType !== ProviderTypeFilter.MERCHANT;
    const favSet = await this.favoriteBranchIds(uid);

    const nameRegex = search
      ? new RegExp(this.escapeRegex(search), 'i')
      : undefined;

    // CANONICAL MARKETPLACE RULE (GAP-P0-027): visibility is gated by
    // operational state + the wallet payment-readiness check below — NEVER by
    // KYC verificationStatus. Verification only drives the isVerified badge on
    // the card, so funded-but-unverified providers list as "Unverified".
    const [branches, washers] = await Promise.all([
      wantMerchant
        ? this.branchModel
            .find({
              isActive: true,
              isOnline: true,
              ...(nameRegex ? { branchName: nameRegex } : {}),
            })
            .exec()
        : Promise.resolve([]),
      wantWasher
        ? this.washerModel
            .find({
              status: WasherStatus.ACTIVE,
              // A washer is matched to customers by DISTANCE, so one without a
              // pin or a radius has no service area and cannot be matched. She
              // used to be listed anyway and then rejected at quote time, which
              // read to the customer as a broken provider rather than one who
              // simply has not finished setting up. Mirrors the isActive /
              // isOnline conditions on branches above.
              serviceRadiusKm: { $ne: null },
              'mapLocation.latitude': { $ne: null },
              'mapLocation.longitude': { $ne: null },
              // Her SHOP name, the same field the card renders — searching the
              // personal `displayName` would return shops under a name the
              // results never show. Mirrors branchName above.
              ...(nameRegex ? { storeName: nameRegex } : {}),
            })
            .exec()
        : Promise.resolve([]),
    ]);

    // Only providers whose fee wallet is activated + funded are discoverable.
    const visible = await this.visibleBranchIds([
      ...branches.map((b) => String(b._id)),
      ...washers.map((w) => w.branchId),
    ]);

    const cards: ProviderCard[] = [];
    for (const branch of branches) {
      if (!visible.has(String(branch._id))) continue;
      const card = await this.merchantCard(branch, favSet, latitude, longitude);
      if (!this.hasSellableCatalog(card)) continue;
      if (
        this.passesFilters(card, {
          category,
          latitude,
          longitude,
          radiusKm,
          minRating,
          openNow,
        })
      ) {
        cards.push(card);
      }
    }
    for (const washer of washers) {
      if (!visible.has(washer.branchId)) continue;
      const card = await this.washerCard(washer, favSet, latitude, longitude);
      if (!this.hasSellableCatalog(card)) continue;
      if (
        this.passesFilters(card, {
          category,
          latitude,
          longitude,
          radiusKm,
          minRating,
          openNow,
        })
      ) {
        cards.push(card);
      }
    }

    this.sortCards(cards, sort);
    await this.applyFeeMarkup(cards);
    return cards.slice(0, limit);
  }

  // Used by FavoritesService so a customer's favorites render as full cards.
  async cardsForFavorites(
    uid: string,
    refs: { branchId: string; providerType: ProviderType }[],
  ): Promise<ProviderCard[]> {
    const favSet = new Set(refs.map((r) => r.branchId));
    const cards: ProviderCard[] = [];
    for (const ref of refs) {
      if (ref.providerType === ProviderType.WASHER) {
        const washer = await this.washerModel
          .findOne({ branchId: ref.branchId })
          .exec();
        if (washer) cards.push(await this.washerCard(washer, favSet));
      } else {
        const branch = await this.branchModel.findById(ref.branchId).exec();
        if (branch) cards.push(await this.merchantCard(branch, favSet));
      }
    }
    await this.applyFeeMarkup(cards);
    return cards;
  }

  // ---------------------------------------------------------------------------
  // providerProfile
  // ---------------------------------------------------------------------------
  async providerProfile(
    uid: string,
    branchId: string,
    providerType: ProviderType,
  ): Promise<ProviderProfile> {
    const favSet = await this.favoriteBranchIds(uid);
    const histogram = await this.ratingHistogram(branchId);

    if (providerType === ProviderType.WASHER) {
      const washer = await this.washerModel.findOne({ branchId }).exec();
      if (!washer) throw new NotFoundException('Home washer not found');
      // A washer's shop settings live on her anchor Branch, so the Pay Later
      // flag is read from there rather than the washer profile. Guarded because
      // a washer profile can carry a branchId that is not a real ObjectId (old
      // fixtures, partially-migrated data) and findById would throw a CastError
      // on the whole profile rather than just missing one boolean.
      const washerBranch = isValidObjectId(branchId)
        ? await this.branchModel.findById(branchId).exec()
        : null;
      const categories = await this.washerCategories(washer);
      const slotsRemaining = await this.slotsRemaining(washer);
      return {
        branchId,
        providerType: ProviderType.WASHER,
        name: washerStoreName(washer),
        initials: this.initials(washerStoreName(washer)),
        verificationBadges: this.washerBadges(washer.verifiedAt != null),
        ratingAverage: washer.ratingAggregate?.overallAverage ?? 0,
        ratingCount: washer.ratingAggregate?.count ?? 0,
        ratingHistogram: histogram,
        description: washer.description ?? undefined,
        logoUrl: washer.logoUrl ?? undefined,
        coverPhotoUrl: washer.coverPhotoUrl ?? undefined,
        featuredPhotos: washer.featuredPhotos ?? [],
        // Privacy-safe: no exact address / coords for washers (screen 073).
        address: undefined,
        mapLocation: undefined,
        areaLabel: this.areaLabel(washer.address),
        operatingHours: undefined,
        // Washers are pickup+return only (screen 067).
        supportedFulfillment: [
          FulfillmentPickupMode.PROVIDER_PICKUP,
          FulfillmentReturnMode.PROVIDER_DELIVERY,
        ],
        policies: await this.policiesFor(branchId),
        serviceCategories: categories,
        slotsRemaining,
        statusText: washer.operatingHours
          ? this.openStatusText(washer.operatingHours)
          : this.washerStatusText(washer, slotsRemaining),
        isAcceptingBookings: await this.washerAcceptingBookings(
          washer,
          slotsRemaining,
        ),
        isFavorite: favSet.has(branchId),
        allowsPayAtHandover: washerBranch?.allowsPayAtHandover ?? false,
        washerVerification: {
          identityVerified: true,
          residenceConfirmed: true,
          servicesReviewed: true,
          paymentAccountVerified: true,
          verifiedOn: washer.verifiedAt ?? undefined,
          recheckCadence: 'Every 6 months',
        },
      };
    }

    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch) throw new NotFoundException('Laundromat not found');
    const categories = await this.merchantCategories(branchId);
    return {
      branchId,
      providerType: ProviderType.MERCHANT,
      name: branch.branchName,
      initials: this.initials(branch.branchName),
      verificationBadges: this.merchantBadges(branch.verifiedAt != null),
      allowsPayAtHandover: branch.allowsPayAtHandover ?? false,
      ratingAverage: branch.ratingAggregate?.overallAverage ?? 0,
      ratingCount: branch.ratingAggregate?.count ?? 0,
      ratingHistogram: histogram,
      description: branch.description ?? undefined,
      logoUrl: branch.logoUrl ?? undefined,
      coverPhotoUrl: branch.coverPhotoUrl ?? undefined,
      // Merchants have no gallery — the field is non-null, so send an empty
      // list rather than letting GraphQL null-error on it.
      featuredPhotos: [],
      address: branch.branchAddress,
      mapLocation: branch.branchMapLocation,
      areaLabel: this.areaLabel(branch.branchAddress),
      operatingHours: branch.operatingHours,
      // Merchants support the full fulfillment matrix (screen 083).
      supportedFulfillment: [
        FulfillmentPickupMode.PROVIDER_PICKUP,
        FulfillmentPickupMode.CUSTOMER_DROPOFF,
        FulfillmentReturnMode.PROVIDER_DELIVERY,
        FulfillmentReturnMode.CUSTOMER_SELF_PICKUP,
      ],
      policies: await this.policiesFor(branchId),
      serviceCategories: categories,
      slotsRemaining: undefined,
      statusText: this.openStatusText(branch.operatingHours),
      isAcceptingBookings: this.merchantAcceptingBookings(branch),
      isFavorite: favSet.has(branchId),
      washerVerification: undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // providerServices — customer-readable catalog. Merchant → public Service
  // rows; washer → only the templates she offers, at the template price.
  // ---------------------------------------------------------------------------
  async providerServices(
    branchId: string,
    providerType: ProviderType,
  ): Promise<ProviderServiceItem[]> {
    // Prices shown to the customer already include the platform fee — at this
    // provider type's own commission rate, which washers and merchants no
    // longer necessarily share.
    const fee =
      await this.platformFeeService.getCommissionPercent(providerType);
    if (providerType === ProviderType.WASHER) {
      const washer = await this.washerModel.findOne({ branchId }).exec();
      if (!washer) throw new NotFoundException('Home washer not found');
      const templates = await this.templateModel
        .find({
          _id: { $in: washer.offeredServiceTemplateIds },
          isActive: true,
        } as any)
        .exec();
      // Each washer prices her own services, so the catalog is resolved per
      // branch rather than read straight off the template.
      const pricing = await this.washerOfferingsService.resolveForBranch(
        branchId,
        templates,
      );
      return templates.map((t) => {
        const p = pricing.get(String(t._id))!;
        return {
          serviceRefId: String(t._id),
          name: t.name,
          description: t.description ?? undefined,
          price: this.markup(p.price, fee),
          pricingType: p.pricingType,
          baseKilos: p.baseKilos,
          excessRate: this.markupOpt(p.excessRate, fee),
          category: undefined,
          // For per-load pricing baseKilos IS the machine capacity, which is a
          // ceiling per run, not a minimum order — only a real minimum
          // billable weight belongs here.
          minKg:
            p.pricingType === PricingType.PER_LOAD_WITH_CAPACITY
              ? undefined
              : (p.minBillableKg ?? p.baseKilos),
          // Counted services carry their unit and the washer's order limits,
          // so the customer app can name what it is asking for and stop an
          // out-of-range count before it becomes a rejected booking.
          unit: p.unit,
          minQuantity: p.minQuantity,
          maxQuantity: p.maxQuantity,
          approved: true, // Lalaba-approved catalog (screen 068)
          readyInHint: undefined,
        };
      });
    }

    const services = await this.serviceModel
      // isActive deliberately NOT checked here — it gates POS only. A service
      // can be online-bookable while paused in POS, or vice versa; isOnline
      // is the one gate this catalog cares about.
      .find({ branchId, isArchived: false, isOnline: true })
      .exec();
    return services.map((s) => ({
      serviceRefId: String(s._id),
      name: s.serviceName,
      description: undefined,
      price: this.markup(s.price, fee),
      pricingType: s.pricingType,
      baseKilos: s.baseKilos ?? undefined,
      excessRate: this.markupOpt(s.excessRate ?? undefined, fee),
      category: s.category,
      minKg: s.baseKilos ?? undefined,
      approved: false,
      readyInHint: s.estimatedMinutes
        ? `Ready in ~${Math.round(s.estimatedMinutes / 60)} hrs`
        : undefined,
    }));
  }

  /**
   * The public policy block. `expressTurnaround` comes from the provider's own
   * configuration so the customer app only offers speed where it is actually
   * sold — asking for it elsewhere is refused at create.
   */
  private async policiesFor(branchId: string) {
    const { config } =
      await this.bookingAvailability.fulfillmentPricingFor(branchId);
    const express = config?.express;
    return {
      freeBatchDelivery: true,
      expressTurnaround: {
        enabled: express?.enabled ?? false,
        feeCentavos: express?.feeCentavos ?? undefined,
        slaHours: express?.slaHours ?? undefined,
      },
    };
  }
  // ---------------------------------------------------------------------------
  // providerPickupDays — the customer's pickup-DAY picker.
  //
  // Replaced providerPickupSlots, which returned 30-minute windows. The window
  // was never a commitment (a free pickup is batched with nearby collections)
  // and no provider surface displayed it, so the customer was choosing a
  // precision nobody could honour or even see. The tier is now chosen
  // explicitly rather than inferred from a window's index in the day.
  // ---------------------------------------------------------------------------
  async providerPickupDays(
    branchId: string,
    providerType: ProviderType,
    fromDate: string,
    days = 7,
  ): Promise<PickupDay[]> {
    const calendar = await this.bookingAvailability.calendar(
      branchId,
      providerType,
      fromDate,
      days,
    );
    // Priced through the same util createOrder charges from, and from THIS
    // provider's own configuration. This used to be a second, independent
    // literal (`isBatch ? 0 : 5000`) sitting next to a separate constants file
    // — which is precisely how an advertised price drifts from a charged one.
    const pricing =
      await this.bookingAvailability.fulfillmentPricingFor(branchId);

    return calendar.map((day) => ({
      date: day.date,
      label: dayLabel(day.date),
      isBookable: day.isBookable,
      remaining: day.remaining,
      unavailableReason: day.unavailableReason
        ? explainUnavailable(day.unavailableReason)
        : undefined,
      freeBatchFeeCentavos: pickupFeeCentavosFor(
        FulfillmentPickupMode.PROVIDER_PICKUP,
        DeliverySubMode.FREE_BATCH,
        pricing.config,
        pricing.ceilingCentavos,
      ),
      paidPickupFeeCentavos: pickupFeeCentavosFor(
        FulfillmentPickupMode.PROVIDER_PICKUP,
        DeliverySubMode.SCHEDULED_PAID,
        pricing.config,
        pricing.ceilingCentavos,
      ),
    }));
  }

  // The caller's OWN public marketplace card — built with the exact same
  // washerCard/merchantCard used for customer discovery, so a provider's
  // "this is what customers see" preview can never drift from the real thing.
  async myProviderCard(uid: string): Promise<ProviderCard | null> {
    const washer = await this.washerModel.findOne({ uid }).exec();
    const card = washer
      ? await this.washerCard(washer, new Set<string>())
      : await (async () => {
          const branch = await this.branchModel.findOne({ uid }).exec();
          return branch ? this.merchantCard(branch, new Set<string>()) : null;
        })();
    if (card) await this.applyFeeMarkup([card]);
    return card;
  }

  // The caller's OWN public cards — one per branch they operate. A washer has a
  // single branch; a merchant may have several. Owner-scoped and NOT gated on
  // discoverability, so a merchant sees every branch (incl. PENDING) on their
  // dashboard carousel. Same fee markup as discoverProviders/myProviderCard.
  async myProviderCards(uid: string): Promise<ProviderCard[]> {
    const washer = await this.washerModel.findOne({ uid }).exec();
    const cards: ProviderCard[] = washer
      ? [await this.washerCard(washer, new Set<string>())]
      : await Promise.all(
          (await this.branchModel.find({ uid }).exec()).map((branch) =>
            this.merchantCard(branch, new Set<string>()),
          ),
        );
    await this.applyFeeMarkup(cards);
    return cards;
  }

  // The caller's OWN full public profile — the exact profile customers see,
  // for the washer/merchant "view as customer" preview.
  async myProviderProfile(uid: string): Promise<ProviderProfile | null> {
    const washer = await this.washerModel.findOne({ uid }).exec();
    if (washer)
      return this.providerProfile(uid, washer.branchId, ProviderType.WASHER);
    const branch = await this.branchModel.findOne({ uid }).exec();
    if (branch)
      return this.providerProfile(
        uid,
        String(branch._id),
        ProviderType.MERCHANT,
      );
    return null;
  }

  // ===========================================================================
  // Card builders
  // ===========================================================================
  private async merchantCard(
    branch: BranchDocument,
    favSet: Set<string>,
    lat?: number,
    lng?: number,
  ): Promise<ProviderCard> {
    const branchId = String(branch._id);
    const { priceFrom, categories } =
      await this.merchantPriceAndCategories(branchId);
    return {
      branchId,
      providerType: ProviderType.MERCHANT,
      name: branch.branchName,
      initials: this.initials(branch.branchName),
      verificationBadges: this.merchantBadges(branch.verifiedAt != null),
      ratingAverage: branch.ratingAggregate?.overallAverage ?? 0,
      ratingCount: branch.ratingAggregate?.count ?? 0,
      statusText: this.openStatusText(branch.operatingHours),
      isAcceptingBookings: this.merchantAcceptingBookings(branch),
      distanceKm: this.distance(lat, lng, branch.branchMapLocation),
      priceFromCentavos: priceFrom,
      serviceCategories: categories,
      slotsRemaining: undefined,
      isFavorite: favSet.has(branchId),
      isVerified: branch.verifiedAt != null, // trust-verified laundromat
      areaLabel: this.areaLabel(branch.branchAddress),
      logoUrl: branch.logoUrl ?? undefined,
      coverPhotoUrl: branch.coverPhotoUrl ?? undefined,
    };
  }

  private async washerCard(
    washer: WasherProfileDocument,
    favSet: Set<string>,
    lat?: number,
    lng?: number,
  ): Promise<ProviderCard> {
    const branchId = washer.branchId;
    const { priceFrom, categories } =
      await this.washerPriceAndCategories(washer);
    const slotsRemaining = await this.slotsRemaining(washer);
    return {
      branchId,
      providerType: ProviderType.WASHER,
      name: washerStoreName(washer),
      operatorName: await this.operatorNameFor(washer.uid),
      initials: this.initials(washerStoreName(washer)),
      verificationBadges: this.washerBadges(washer.verifiedAt != null),
      ratingAverage: washer.ratingAggregate?.overallAverage ?? 0,
      ratingCount: washer.ratingAggregate?.count ?? 0,
      statusText: washer.operatingHours
        ? this.openStatusText(washer.operatingHours)
        : this.washerStatusText(washer, slotsRemaining),
      isAcceptingBookings: await this.washerAcceptingBookings(
        washer,
        slotsRemaining,
      ),
      // Distance uses the washer's coords for filtering/sorting only — the
      // coords themselves are never returned (privacy-safe).
      distanceKm: this.distance(lat, lng, washer.mapLocation),
      serviceRadiusKm: washer.serviceRadiusKm ?? null,
      priceFromCentavos: priceFrom,
      serviceCategories: categories,
      slotsRemaining: await this.slotsRemaining(washer),
      isFavorite: favSet.has(branchId),
      isVerified: washer.verifiedAt != null, // identity-verified home washer
      areaLabel: this.areaLabel(washer.address),
      logoUrl: washer.logoUrl ?? undefined,
      coverPhotoUrl: washer.coverPhotoUrl ?? undefined,
    };
  }

  // ===========================================================================
  // Catalog helpers
  // ===========================================================================
  private async merchantPriceAndCategories(
    branchId: string,
  ): Promise<{ priceFrom?: number; categories: string[] }> {
    const services = await this.serviceModel
      // isActive deliberately NOT checked here — it gates POS only. A service
      // can be online-bookable while paused in POS, or vice versa; isOnline
      // is the one gate this catalog cares about.
      .find({ branchId, isArchived: false, isOnline: true })
      .exec();
    if (!services.length) return { categories: [] };
    return {
      priceFrom: Math.min(...services.map((s) => s.price)),
      categories: [...new Set(services.map((s) => s.category))],
    };
  }

  private async merchantCategories(branchId: string): Promise<string[]> {
    return (await this.merchantPriceAndCategories(branchId)).categories;
  }

  private async washerPriceAndCategories(
    washer: WasherProfileDocument,
  ): Promise<{ priceFrom?: number; categories: string[] }> {
    const templates = await this.templateModel
      .find({
        _id: { $in: washer.offeredServiceTemplateIds },
        isActive: true,
      } as any)
      .exec();
    if (!templates.length) return { categories: [] };
    // "From ₱X" has to be comparable across washers, and a headline amount no
    // longer is: ₱35/kg, ₱180/load and "₱250 for the first 7 kg" are three
    // different units. Every offering is evaluated at the same reference
    // basket so the number being sorted and filtered on is a like-for-like
    // total, not a mix of rates.
    const pricing = await this.washerOfferingsService.resolveForBranch(
      String(washer.branchId),
      templates,
    );
    //
    // Per-item services are excluded from the basket entirely rather than
    // evaluated at quantity 1 — ₱250 per comforter is not a cheaper or dearer
    // answer to "what does 7 kg of laundry cost", it answers a different
    // question. Letting one in would rank a washer who happens to offer
    // comforters as the cheapest washer for ordinary laundry.
    const totals = templates
      .map((t) => pricing.get(String(t._id))!)
      .filter(comparableInDiscovery)
      .map((p) =>
        calculateServiceLineTotal(p, DISCOVERY_REFERENCE_WEIGHT_KG, null),
      );
    return {
      // A washer who offers ONLY per-item services has no comparable price.
      // Undefined (not Infinity, which Math.min returns for an empty list)
      // keeps her listed and simply unsorted on price.
      priceFrom: totals.length ? Math.min(...totals) : undefined,
      categories: templates.map((t) => t.name),
    };
  }

  private async washerCategories(
    washer: WasherProfileDocument,
  ): Promise<string[]> {
    return (await this.washerPriceAndCategories(washer)).categories;
  }

  // ===========================================================================
  // Ratings histogram (star buckets 1..5) — reactive aggregate over Rating docs.
  // ===========================================================================
  private async ratingHistogram(
    branchId: string,
  ): Promise<RatingHistogramBucket[]> {
    const rows = await this.ratingModel
      .aggregate([
        { $match: { branchId, isRemoved: { $ne: true } } },
        {
          $group: {
            _id: { $round: ['$overallScore', 0] },
            count: { $sum: 1 },
          },
        },
      ])
      .exec();
    const byStar = new Map<number, number>(
      rows.map((r: { _id: unknown; count: number }) => [
        Number(r._id),
        r.count,
      ]),
    );
    return [5, 4, 3, 2, 1].map((star) => ({
      star,
      count: byStar.get(star) ?? 0,
    }));
  }

  // ===========================================================================
  // Filters / sort / geo / formatting
  // ===========================================================================
  private passesFilters(
    card: ProviderCard,
    f: {
      category?: string;
      latitude?: number;
      longitude?: number;
      radiusKm?: number;
      minRating?: number;
      openNow?: boolean;
    },
  ): boolean {
    if (f.category && !card.serviceCategories.includes(f.category))
      return false;
    // Two different radii, and they are not interchangeable.
    //
    // The provider's own service radius is a HARD constraint: createOrder
    // enforces it (provider-eligibility assertWithinServiceRadius), so a card
    // beyond it is advertising a provider who will refuse the booking after
    // the customer has picked services, a day, a tier and a payment method.
    // It applies even when the customer chose "Any" distance — "any" means
    // any distance SHE serves, not anywhere on earth.
    if (
      f.latitude != null &&
      f.longitude != null &&
      card.distanceKm != null &&
      card.serviceRadiusKm != null &&
      card.distanceKm > card.serviceRadiusKm
    ) {
      return false;
    }
    // The customer's filter is a PREFERENCE, and can only narrow further.
    if (
      f.latitude != null &&
      f.longitude != null &&
      f.radiusKm != null &&
      card.distanceKm != null &&
      card.distanceKm > f.radiusKm
    ) {
      return false;
    }
    if (f.minRating != null && card.ratingAverage < f.minRating) return false;
    // "Open now" — anything whose status isn't explicitly Closed (open hours,
    // 24h, or a washer accepting bookings).
    if (f.openNow && /^closed/i.test(card.statusText)) return false;
    return true;
  }

  private sortCards(cards: ProviderCard[], sort: ProviderSort): void {
    if (sort === ProviderSort.TOP_RATED) {
      cards.sort((a, b) => b.ratingAverage - a.ratingAverage);
    } else {
      cards.sort(
        (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
      );
    }
  }

  private async favoriteBranchIds(uid: string): Promise<Set<string>> {
    const favs = await this.favoriteModel
      .find({ uid })
      .select('branchId')
      .exec();
    return new Set(favs.map((f) => f.branchId));
  }

  private distance(
    lat?: number,
    lng?: number,
    loc?: { latitude: number; longitude: number } | null,
  ): number | undefined {
    if (lat == null || lng == null || !loc) return undefined;
    const R = 6371; // km
    const dLat = this.toRad(loc.latitude - lat);
    const dLng = this.toRad(loc.longitude - lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat)) *
        Math.cos(this.toRad(loc.latitude)) *
        Math.sin(dLng / 2) ** 2;
    return (
      Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10
    );
  }

  private toRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  /**
   * Slots left against Admin's per-washer daily order cap, or `undefined` when
   * she has none — the same "no number to show" the merchant cards use, rather
   * than inventing one. There is no platform default behind this field: the
   * local `20` that used to stand in for an unset cap made every washer card
   * advertise a ceiling no admin had chosen.
   *
   * Today's usage is counted with CAP_COUNTED_STATUSES — the same filter the
   * acceptance-time atomic guard enforces — so the number the card advertises
   * is the number a booking attempt will actually honour. A pending request
   * she hasn't accepted yet doesn't consume a slot.
   */
  private async slotsRemaining(
    washer: WasherProfileDocument,
  ): Promise<number | undefined> {
    const cap = washer.maxOrdersPerDay;
    if (cap == null) return undefined;
    const used = await this.orderModel
      .countDocuments({
        'provider.branchId': washer.branchId,
        createdAt: { $gte: startOfTodayPH() },
        status: { $in: CAP_COUNTED_STATUSES },
      })
      .exec();
    return Math.max(0, cap - used);
  }

  private washerStatusText(
    washer: WasherProfileDocument,
    left: number | undefined,
  ): string {
    if (!washer.isAvailable) return 'Not accepting bookings';
    // No cap ⇒ no slot arithmetic to report, so say only what is known.
    if (left == null) return 'Accepting bookings';
    if (left <= 0) return 'Fully booked today';
    if (left <= 3) return `${left} slot${left === 1 ? '' : 's'} left`;
    return 'Accepting bookings';
  }

  // The real booking gate ProviderEligibilityService.assertProviderBookable
  // enforces for a washer (status/wallet/service-area are already prerequisites
  // for being listed at all, so isAvailable + the daily cap + the booking-
  // availability config are what's left to mirror). This USED to check only
  // isAvailable + slots, so a washer who paused herself on the Booking
  // Availability screen (bookingsPaused) or turned off scheduled bookings
  // (acceptScheduledBookings) still showed "Accepting bookings" (green) to
  // customers — isBookingAccepting() is the one real computation both this
  // and that screen's own summary call, so they can't drift apart again.
  private async washerAcceptingBookings(
    washer: WasherProfileDocument,
    slotsRemaining: number | undefined,
  ): Promise<boolean> {
    if (!washer.isAvailable) return false;
    if (slotsRemaining != null && slotsRemaining <= 0) return false;
    const config = await this.bookingAvailability.findConfig(washer.branchId);
    if (!config) return true; // no config yet ⇒ platform defaults, not paused
    const entitlement = await this.bookingPolicy.entitlementFor(
      washer.branchId,
      ProviderType.WASHER,
    );
    return isBookingAccepting(config, entitlement);
  }

  // Mirrors ProviderEligibilityService.assertProviderBookable's merchant branch.
  private merchantAcceptingBookings(branch: BranchDocument): boolean {
    return branch.isActive && branch.isOnline;
  }

  private openStatusText(hours?: OperatingHours): string {
    if (!hours) return 'Open';
    const now = new Date();
    const day = (hours as any)[DAY_KEYS[now.getDay()]];
    if (!day || day.isOpen === false) return 'Closed';
    if (day.is24Hours) return 'Open 24 hours';
    const slot = day.timeSlots?.[0];
    if (slot?.close) return `Open until ${this.fmtClock(slot.close)}`;
    return 'Open';
  }

  private areaLabel(
    addr?: { barangayName?: string; cityMunicipalityName?: string } | null,
  ): string | undefined {
    if (!addr) return undefined;
    return [addr.barangayName, addr.cityMunicipalityName]
      .filter(Boolean)
      .join(', ');
  }

  private initials(name: string): string {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }

  private hourOf(hhmm: string): number {
    return parseInt(hhmm.split(':')[0], 10) || 0;
  }

  private fmtHour(h: number): string {
    const period = h >= 12 ? 'PM' : 'AM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}:00 ${period}`;
  }

  private fmtClock(hhmm: string): string {
    const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
    const period = h >= 12 ? 'PM' : 'AM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}:${String(m || 0).padStart(2, '0')} ${period}`;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
