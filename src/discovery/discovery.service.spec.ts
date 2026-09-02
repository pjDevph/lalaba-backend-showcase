import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { DiscoveryService } from './discovery.service';
import {
  Branch,
  BranchDocument,
  BranchSchema,
  BranchVerificationStatus,
} from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
  WasherProfileSchema,
  WasherStatus,
  VerificationStatus,
} from '../washer/schemas/washer-profile.schema';
import {
  Service,
  ServiceDocument,
  ServiceSchema,
  PricingType,
  ServiceCategory,
} from '../services/schemas/service.schema';
import {
  WasherServiceTemplate,
  WasherServiceTemplateDocument,
  WasherServiceTemplateSchema,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { Rating, RatingSchema } from '../ratings/schemas/rating.schema';
import {
  Favorite,
  FavoriteDocument,
  FavoriteSchema,
} from '../favorites/schemas/favorite.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Wallet,
  WalletDocument,
  WalletSchema,
} from '../wallets/schemas/wallet.schema';
import { PlatformFeeService } from '../platform-fee/platform-fee.service';
import { WasherServiceOfferingsService } from '../washer-service-offerings/washer-service-offerings.service';
import {
  WasherServiceOffering,
  WasherServiceOfferingSchema,
} from '../washer-service-offerings/schemas/washer-service-offering.schema';
import {
  OrderStatus,
  ProviderType,
} from '../online-orders/schemas/order-status.enum';
import {
  ProviderTypeFilter,
  ProviderSort,
} from './dto/discover-providers.input';
import { BookingAvailabilityService } from '../booking-availability/booking-availability.service';
import {
  BookingAvailabilityConfig,
  BookingAvailabilityConfigSchema,
} from '../booking-availability/schemas/booking-availability-config.schema';
import {
  BookingDateOverride,
  BookingDateOverrideSchema,
} from '../booking-availability/schemas/booking-date-override.schema';
import {
  BookingBlackout,
  BookingBlackoutSchema,
} from '../booking-availability/schemas/booking-blackout.schema';
import {
  BookingSlotCounter,
  BookingSlotCounterSchema,
} from '../booking-availability/schemas/booking-slot-counter.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import { BookingPolicyService } from '../booking-policy/booking-policy.service';
import {
  BookingPolicy,
  BookingPolicySchema,
} from '../booking-policy/schemas/booking-policy.schema';
import {
  BookingMilestone,
  BookingMilestoneSchema,
} from '../booking-policy/schemas/booking-milestone.schema';
import {
  BookingCampaign,
  BookingCampaignSchema,
} from '../booking-policy/schemas/booking-campaign.schema';

const day = () => ({
  isOpen: true,
  is24Hours: false,
  timeSlots: [{ open: '08:00', close: '20:00' }],
});
const hours = () => ({
  monday: day(),
  tuesday: day(),
  wednesday: day(),
  thursday: day(),
  friday: day(),
  saturday: day(),
  sunday: day(),
});

const branchDoc = (over: Record<string, any> = {}) => ({
  uid: 'merch-uid',
  branchName: 'CleanWave Laundry',
  branchAddress: {
    regionName: 'Region IV-A',
    provinceName: 'Rizal',
    cityMunicipalityName: 'Angono',
    barangayName: 'San Isidro',
    streetAddress: '14 M.L. Quezon St',
  },
  branchMapLocation: { latitude: 14.52, longitude: 121.15 },
  branchPhoneNumber: '09171234567',
  operatingHours: hours(),
  ratingAggregate: { count: 126, overallAverage: 4.8 },
  verificationStatus: BranchVerificationStatus.APPROVED,
  isActive: true,
  isOnline: true,
  ...over,
});

// discoverProviders only surfaces providers whose fee wallet is activated
// (₱1,000 onboarding top-up) and funded past the ₱100 accept-a-booking floor
// — see DiscoveryService.walletVisible. Tests that go through discoverProviders
// must create one of these per branchId or the provider is silently excluded.
const activeWallet = (branchId: string) => ({
  branchId,
  balanceCentavos: 100_000,
  activatedAt: new Date(),
});

// discoverProviders ALSO requires a non-empty catalog — a funded provider with
// nothing to sell is not listed (see DiscoveryService.hasSellableCatalog).
// Like activeWallet above, tests that expect a provider to be LISTED must seed
// one of these; tests asserting exclusion deliberately skip it.
const merchantCatalog = (branchId: string) => ({
  uid: 'merch-uid',
  branchId,
  serviceName: 'Wash & Fold',
  price: 6500,
  pricingType: PricingType.PER_KILO,
  category: ServiceCategory.WASH_AND_FOLD,
});

// Seeded fresh each test (afterEach wipes every collection) and referenced by
// washerDoc's default, so washer fixtures clear the catalog gate without every
// test having to create a template.
let catalogTemplateId = '';

const washerCatalogTemplate = {
  // ServiceTemplate.name is uniquely indexed, so this must not collide with
  // templates individual tests create.
  name: 'Catalog Fixture Service',
  basePriceCentavos: 25000,
  baseWeightKg: 7,
  excessRatePerKgCentavos: 3000,
  isActive: true,
};

const washerDoc = (over: Record<string, any> = {}) => ({
  uid: 'washer-uid',
  displayName: "Maria's Home Laundry",
  address: {
    regionName: 'Region IV-A',
    provinceName: 'Rizal',
    cityMunicipalityName: 'Angono',
    barangayName: 'Poblacion Ibaba',
    streetAddress: '7 Secret St',
  },
  mapLocation: { latitude: 14.53, longitude: 121.16 },
  // A pin without a radius is not a service area — discovery excludes it, the
  // same way it excludes an offline branch. This fixture is a fully set-up
  // washer, so it carries both.
  serviceRadiusKm: 5,
  ratingAggregate: { count: 38, overallAverage: 4.9 },
  status: WasherStatus.ACTIVE,
  verificationStatus: VerificationStatus.APPROVED,
  isAvailable: true,
  maxOrdersPerDay: 20,
  offeredServiceTemplateIds: [catalogTemplateId],
  branchId: 'washer-branch-anchor',
  ...over,
});

describe('DiscoveryService (integration)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let service: DiscoveryService;
  let module: TestingModule;
  let branchModel: Model<BranchDocument>;
  let washerModel: Model<WasherProfileDocument>;
  let serviceModel: Model<ServiceDocument>;
  let templateModel: Model<WasherServiceTemplateDocument>;
  let favoriteModel: Model<FavoriteDocument>;
  let walletModel: Model<WalletDocument>;
  let orderModel: Model<OnlineOrderDocument>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: Branch.name, schema: BranchSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: Service.name, schema: ServiceSchema },
          {
            name: WasherServiceTemplate.name,
            schema: WasherServiceTemplateSchema,
          },
          { name: Rating.name, schema: RatingSchema },
          { name: Favorite.name, schema: FavoriteSchema },
          { name: User.name, schema: UserSchema },
          { name: Wallet.name, schema: WalletSchema },
          {
            name: WasherServiceOffering.name,
            schema: WasherServiceOfferingSchema,
          },
          {
            name: BookingAvailabilityConfig.name,
            schema: BookingAvailabilityConfigSchema,
          },
          {
            name: BookingDateOverride.name,
            schema: BookingDateOverrideSchema,
          },
          { name: BookingBlackout.name, schema: BookingBlackoutSchema },
          {
            name: BookingSlotCounter.name,
            schema: BookingSlotCounterSchema,
          },
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
          { name: BookingPolicy.name, schema: BookingPolicySchema },
          { name: BookingMilestone.name, schema: BookingMilestoneSchema },
          { name: BookingCampaign.name, schema: BookingCampaignSchema },
        ]),
      ],
      providers: [
        DiscoveryService,
        // Real service: with no offering rows seeded every washer resolves to
        // her template's pricing, which is what these expectations encode.
        WasherServiceOfferingsService,
        // Real service: providerPickupSlots now resolves windows through it,
        // and an unseeded provider falls back to the platform defaults.
        BookingAvailabilityService,
        // Pickup slots resolve through the platform entitlement now.
        BookingPolicyService,
        {
          provide: PlatformFeeService,
          useValue: {
            getCurrentFeePercent: jest.fn().mockResolvedValue(0),
            // 0% for both, so the card assertions compare against the
            // provider's own configured price with no markup to unpick.
            getCommissionPercent: jest.fn().mockResolvedValue(0),
          },
        },
      ],
    }).compile();

    service = module.get(DiscoveryService);
    connection = module.get<Connection>(getConnectionToken());
    branchModel = module.get(`${Branch.name}Model`);
    washerModel = module.get(`${WasherProfile.name}Model`);
    serviceModel = module.get(`${Service.name}Model`);
    templateModel = module.get(`${WasherServiceTemplate.name}Model`);
    favoriteModel = module.get(`${Favorite.name}Model`);
    walletModel = module.get(`${Wallet.name}Model`);
    orderModel = module.get(`${OnlineOrder.name}Model`);
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await module.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    catalogTemplateId = String(
      (await templateModel.create(washerCatalogTemplate))._id,
    );
  });

  afterEach(async () => {
    for (const key in connection.collections) {
      await connection.collections[key].deleteMany({});
    }
  });

  describe('discoverProviders — federation gate', () => {
    it('[HP] returns both an approved merchant and an approved washer', async () => {
      const b = await branchModel.create(branchDoc());
      const w = await washerModel.create(washerDoc());
      await walletModel.create(activeWallet(String(b._id)));
      await serviceModel.create(merchantCatalog(String(b._id)));
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {});
      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.providerType).sort()).toEqual([
        ProviderType.MERCHANT,
        ProviderType.WASHER,
      ]);
    });

    it('[EC] excludes an offline merchant and an inactive merchant, regardless of wallet', async () => {
      const offline = await branchModel.create(
        branchDoc({ branchName: 'Offline Co', isOnline: false }),
      );
      const inactive = await branchModel.create(
        branchDoc({ branchName: 'Inactive Co', isActive: false }),
      );
      const live = await branchModel.create(
        branchDoc({ branchName: 'Live Co' }),
      );
      await walletModel.create(activeWallet(String(offline._id)));
      await serviceModel.create(merchantCatalog(String(offline._id)));
      await walletModel.create(activeWallet(String(inactive._id)));
      await serviceModel.create(merchantCatalog(String(inactive._id)));
      await walletModel.create(activeWallet(String(live._id)));
      await serviceModel.create(merchantCatalog(String(live._id)));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.MERCHANT,
      });
      expect(cards).toHaveLength(1);
      expect(cards[0].name).toBe('Live Co');
    });

    it('[EC] excludes a funded merchant with an empty catalog', async () => {
      const b = await branchModel.create(
        branchDoc({ branchName: 'No Menu Co' }),
      );
      await walletModel.create(activeWallet(String(b._id)));
      // deliberately no serviceModel.create — nothing to sell

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.MERCHANT,
      });
      expect(cards).toHaveLength(0);
    });

    it('[EC] excludes a funded washer offering no service templates', async () => {
      const w = await washerModel.create(
        washerDoc({
          displayName: 'No Menu Maria',
          offeredServiceTemplateIds: [],
        }),
      );
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
      });
      expect(cards).toHaveLength(0);
    });

    // Customers are matched to home washers purely by distance, so a washer
    // with no service area cannot be matched. She used to be listed and then
    // rejected at quote time, which reads as a broken provider rather than an
    // unfinished one.
    it('[EC] excludes a funded washer with no service radius', async () => {
      const w = await washerModel.create(
        washerDoc({ displayName: 'No Radius Rita', serviceRadiusKm: null }),
      );
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
      });
      expect(cards).toHaveLength(0);
    });

    it('[EC] excludes a funded washer with no map pin', async () => {
      const w = await washerModel.create(
        washerDoc({ displayName: 'No Pin Nina', mapLocation: null }),
      );
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
      });
      expect(cards).toHaveLength(0);
    });

    it('[EC] excludes a washer whose only template is inactive', async () => {
      const dead = await templateModel.create({
        name: 'Retired Service',
        basePriceCentavos: 20000,
        baseWeightKg: 7,
        excessRatePerKgCentavos: 3000,
        isActive: false,
      });
      const w = await washerModel.create(
        washerDoc({
          displayName: 'Stale Menu Maria',
          offeredServiceTemplateIds: [String(dead._id)],
        }),
      );
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
      });
      expect(cards).toHaveLength(0);
    });

    it('[EC] excludes a non-ACTIVE washer', async () => {
      const w = await washerModel.create(
        washerDoc({
          displayName: 'Suspended Maria',
          status: WasherStatus.SUSPENDED,
        }),
      );
      await walletModel.create(activeWallet(w.branchId));
      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
      });
      expect(cards).toHaveLength(0);
    });
  });

  // CANONICAL MARKETPLACE RULE (GAP-P0-027): visibility is gated ONLY by
  // operational state + wallet payment-readiness. KYC verificationStatus
  // must never hide a provider — it only flips the isVerified badge.
  // ── Service radius ────────────────────────────────────────────────────────
  //
  // Two radii, and they are not the same thing. The washer's own
  // serviceRadiusKm is a HARD constraint enforced by createOrder
  // (provider-eligibility assertWithinServiceRadius); the customer's filter is
  // a preference. Discovery used to apply only the second, so a washer sitting
  // between the two was listed and then refused the booking after the customer
  // had chosen services, a day, a tier and a payment method.

  describe('discoverProviders — the washer’s own service radius', () => {
    // Angono; the fixture washer sits at 14.53, 121.16 with a 5 km radius.
    const NEARBY = { latitude: 14.5328507, longitude: 121.152051 };
    // ~14 km away — the distance that produced the live bug report.
    const FAR = { latitude: 14.6494, longitude: 121.0489 };

    const seedWasher = async (over: Record<string, any> = {}) => {
      const w = await washerModel.create(washerDoc(over));
      await walletModel.create(activeWallet(w.branchId));
      return w;
    };

    it('[HP] lists a washer whose service area covers the address', async () => {
      await seedWasher();
      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
        ...NEARBY,
      });
      expect(cards).toHaveLength(1);
    });

    // THE regression guard: no customer radius filter at all.
    it('[EC] hides a washer beyond her own radius even with no distance filter', async () => {
      await seedWasher();
      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
        ...FAR,
      });
      expect(cards).toHaveLength(0);
    });

    // "Any distance" means any distance SHE serves, not anywhere on earth.
    it('[EC] hides her beyond her radius even when the filter is wider', async () => {
      await seedWasher();
      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
        radiusKm: 50,
        ...FAR,
      });
      expect(cards).toHaveLength(0);
    });

    it('[EC] the customer filter can still narrow further than her radius', async () => {
      await seedWasher(); // 0.9 km away, 5 km radius — inside her area
      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
        radiusKm: 0.5,
        ...NEARBY,
      });
      expect(cards).toHaveLength(0);
    });

    // Discovery must agree with the create path, not merely be stricter.
    it('[HP] a listed washer is one createOrder would accept', async () => {
      await seedWasher({ serviceRadiusKm: 3 });
      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
        ...NEARBY,
      });
      for (const card of cards) {
        expect(card.distanceKm).toBeLessThanOrEqual(3);
      }
    });

    // A merchant has no service radius; the new rule must not touch it. At the
    // same distance that hides the washer, a merchant is listed as long as the
    // customer's own filter allows it.
    it('[HP] a distant merchant is governed only by the customer filter', async () => {
      const b = await branchModel.create(branchDoc());
      await walletModel.create(activeWallet(String(b._id)));
      await serviceModel.create(merchantCatalog(String(b._id)));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.MERCHANT,
        radiusKm: 50,
        ...FAR,
      });
      expect(cards).toHaveLength(1);
    });
  });

  describe('discoverProviders — canonical KYC-visibility cases', () => {
    it('[EC] case 1: no wallet → hidden (both provider types)', async () => {
      await branchModel.create(branchDoc({ branchName: 'No Wallet Co' }));
      await washerModel.create(washerDoc({ displayName: 'No Wallet Maria' }));

      const cards = await service.discoverProviders('cust-1', {});
      expect(cards).toHaveLength(0);
    });

    it('[HP] case 2: funded + no KYC submission (PENDING, never verified) → visible, unverified', async () => {
      const b = await branchModel.create(
        branchDoc({
          verificationStatus: BranchVerificationStatus.PENDING,
          verifiedAt: null,
        }),
      );
      const w = await washerModel.create(
        washerDoc({
          verificationStatus: VerificationStatus.PENDING,
          verifiedAt: null,
        }),
      );
      await walletModel.create(activeWallet(String(b._id)));
      await serviceModel.create(merchantCatalog(String(b._id)));
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {});
      expect(cards).toHaveLength(2);
      expect(cards.every((c) => c.isVerified === false)).toBe(true);
    });

    it('[HP] case 3: funded + KYC pending review → visible, unverified', async () => {
      const w = await washerModel.create(
        washerDoc({
          verificationStatus: VerificationStatus.PENDING,
          verifiedAt: null,
        }),
      );
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
      });
      expect(cards).toHaveLength(1);
      expect(cards[0].isVerified).toBe(false);
      expect(cards[0].verificationBadges).toContain('HOME_WASHER');
      expect(cards[0].verificationBadges).not.toContain('VERIFIED_HOME_WASHER');
    });

    it('[HP] case 4: funded + KYC approved → visible, verified', async () => {
      const b = await branchModel.create(
        branchDoc({
          verificationStatus: BranchVerificationStatus.APPROVED,
          verifiedAt: new Date(),
        }),
      );
      const w = await washerModel.create(
        washerDoc({
          verificationStatus: VerificationStatus.APPROVED,
          verifiedAt: new Date(),
        }),
      );
      await walletModel.create(activeWallet(String(b._id)));
      await serviceModel.create(merchantCatalog(String(b._id)));
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {});
      expect(cards).toHaveLength(2);
      expect(cards.every((c) => c.isVerified === true)).toBe(true);
      const washerCard = cards.find(
        (c) => c.providerType === ProviderType.WASHER,
      );
      expect(washerCard?.verificationBadges).toContain('VERIFIED_HOME_WASHER');
    });

    it('[EC] case 5: funded + KYC rejected → still visible, unverified', async () => {
      const b = await branchModel.create(
        branchDoc({
          branchName: 'Rejected Co',
          verificationStatus: BranchVerificationStatus.REJECTED,
          verifiedAt: null,
        }),
      );
      const w = await washerModel.create(
        washerDoc({
          displayName: 'Rejected Maria',
          verificationStatus: VerificationStatus.REJECTED,
          verifiedAt: null,
        }),
      );
      await walletModel.create(activeWallet(String(b._id)));
      await serviceModel.create(merchantCatalog(String(b._id)));
      await walletModel.create(activeWallet(w.branchId));

      const cards = await service.discoverProviders('cust-1', {});
      expect(cards).toHaveLength(2);
      expect(cards.every((c) => c.isVerified === false)).toBe(true);
    });

    it('[EC] funded but below the ₱100 floor or not activated → hidden', async () => {
      const poor = await branchModel.create(
        branchDoc({ branchName: 'Poor Co' }),
      );
      const dormant = await branchModel.create(
        branchDoc({ branchName: 'Dormant Co' }),
      );
      await walletModel.create({
        branchId: String(poor._id),
        balanceCentavos: 9_999,
        activatedAt: new Date(),
      });
      await walletModel.create({
        branchId: String(dormant._id),
        balanceCentavos: 100_000,
      });

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.MERCHANT,
      });
      expect(cards).toHaveLength(0);
    });
  });

  describe('discoverProviders — ranking & favorites', () => {
    it('[HP] top_rated sorts by rating average desc', async () => {
      const lower = await branchModel.create(
        branchDoc({
          branchName: 'Lower',
          ratingAggregate: { count: 5, overallAverage: 4.1 },
        }),
      );
      const higher = await branchModel.create(
        branchDoc({
          branchName: 'Higher',
          ratingAggregate: { count: 9, overallAverage: 4.9 },
        }),
      );
      await walletModel.create(activeWallet(String(lower._id)));
      await serviceModel.create(merchantCatalog(String(lower._id)));
      await walletModel.create(activeWallet(String(higher._id)));
      await serviceModel.create(merchantCatalog(String(higher._id)));

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.MERCHANT,
        sort: ProviderSort.TOP_RATED,
      });
      expect(cards[0].name).toBe('Higher');
    });

    it('[HP] flags favorites for the requesting customer', async () => {
      const b = await branchModel.create(branchDoc());
      await walletModel.create(activeWallet(String(b._id)));
      await serviceModel.create(merchantCatalog(String(b._id)));
      await favoriteModel.create({
        uid: 'cust-1',
        branchId: String(b._id),
        providerType: ProviderType.MERCHANT,
      });

      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.MERCHANT,
      });
      expect(cards[0].isFavorite).toBe(true);
      // A different customer sees it as not-favorited.
      const other = await service.discoverProviders('cust-2', {
        providerType: ProviderTypeFilter.MERCHANT,
      });
      expect(other[0].isFavorite).toBe(false);
    });
  });

  describe('providerProfile — washer privacy', () => {
    it('[HP] washer profile never exposes exact address or coordinates', async () => {
      const w = await washerModel.create(washerDoc({ verifiedAt: new Date() }));
      const profile = await service.providerProfile(
        'cust-1',
        w.branchId,
        ProviderType.WASHER,
      );
      expect(profile.address).toBeUndefined();
      expect(profile.mapLocation).toBeUndefined();
      expect(profile.areaLabel).toContain('Angono');
      expect(profile.verificationBadges).toContain('VERIFIED_HOME_WASHER');
      expect(profile.washerVerification?.identityVerified).toBe(true);
    });

    it('[HP] merchant profile exposes exact address and coordinates', async () => {
      const b = await branchModel.create(branchDoc());
      const profile = await service.providerProfile(
        'cust-1',
        String(b._id),
        ProviderType.MERCHANT,
      );
      expect(profile.address?.streetAddress).toBe('14 M.L. Quezon St');
      expect(profile.mapLocation?.latitude).toBeCloseTo(14.52);
    });
  });

  // A home washer's shop is listed under `storeName`, the required field she
  // edits on the washer app's Online Store screen. Her `displayName` is her own
  // name and NEVER stands in for it — it reaches the customer only as the
  // separate "Operated by" line.
  describe('washer storefront name', () => {
    const listWasher = async (over: Record<string, any>, search?: string) => {
      const w = await washerModel.create(washerDoc(over));
      await walletModel.create(activeWallet(w.branchId));
      return {
        w,
        cards: await service.discoverProviders('cust-1', {
          providerType: ProviderTypeFilter.WASHER,
          ...(search ? { search } : {}),
        }),
      };
    };

    it('[HP] lists a washer under her store name, not her own name', async () => {
      const { w, cards } = await listWasher({
        displayName: 'Maria Dela Cruz',
        storeName: 'Sparkle Suds Laundry',
      });
      expect(cards).toHaveLength(1);
      expect(cards[0].name).toBe('Sparkle Suds Laundry');
      expect(cards[0].initials).toBe('SS');

      const profile = await service.providerProfile(
        'cust-1',
        w.branchId,
        ProviderType.WASHER,
      );
      expect(profile.name).toBe('Sparkle Suds Laundry');
    });

    // Both cases are unreachable through the app — the name is seeded at
    // registration, the mutation rejects a blank one, and the backfill fills
    // every legacy row. Asserted anyway because the failure mode being guarded
    // against is a washer's LEGAL NAME appearing as a shop name, and a nullable
    // column is always one bad write away from being null.
    it('[EC] never substitutes her display name when no store name is stored', async () => {
      const { w, cards } = await listWasher({
        displayName: 'Maria Dela Cruz',
        storeName: null,
      });
      expect(cards[0].name).not.toBe('Maria Dela Cruz');
      expect(cards[0].name).toBe('Home Laundry');

      const profile = await service.providerProfile(
        'cust-1',
        w.branchId,
        ProviderType.WASHER,
      );
      expect(profile.name).toBe('Home Laundry');
    });

    it('[EC] treats a whitespace-only store name as unset', async () => {
      const { cards } = await listWasher({
        displayName: 'Maria Dela Cruz',
        storeName: '   ',
      });
      expect(cards[0].name).toBe('Home Laundry');
    });

    it('[HP] search matches the store name customers actually see', async () => {
      const { cards } = await listWasher(
        { displayName: 'Maria Dela Cruz', storeName: 'Sparkle Suds Laundry' },
        'sparkle',
      );
      expect(cards).toHaveLength(1);
      expect(cards[0].name).toBe('Sparkle Suds Laundry');
    });

    it('[EC] search does not match her personal name', async () => {
      const { cards } = await listWasher(
        { displayName: 'Maria Dela Cruz', storeName: 'Sparkle Suds Laundry' },
        'dela cruz',
      );
      // Matching it would return a shop under a name the results never show.
      expect(cards).toHaveLength(0);
    });
  });

  // The daily order cap is Admin's per-washer number (setWasherDailyOrderCap)
  // and there is no platform default behind it. A local 20 used to fill in for
  // an unset cap, so every washer card advertised a ceiling no admin had chosen
  // — and one that disagreed with the booking policy the engine enforces.
  describe('washer daily order cap', () => {
    // Used slots are real orders now, exactly as the booking cap counts them
    // (today, minus cancelled/rejected/refunded), so each case seeds its own.
    const seedOrders = async (
      branchId: string,
      count: number,
      status: OrderStatus = OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
    ) => {
      for (let i = 0; i < count; i++) {
        await orderModel.create({
          customer: { uid: 'cust-1' },
          provider: {
            branchId,
            providerUid: 'washer-1',
            providerType: ProviderType.WASHER,
          },
          serviceLines: [{ name: 'Wash & Fold', quantity: 1 }],
          fulfillment: {},
          pricing: {},
          status,
        });
      }
    };

    const washerCard = async (
      over: Record<string, any>,
      usedToday = 0,
      usedStatus?: OrderStatus,
    ) => {
      const w = await washerModel.create(washerDoc(over));
      await walletModel.create(activeWallet(w.branchId));
      await seedOrders(w.branchId, usedToday, usedStatus);
      const cards = await service.discoverProviders('cust-1', {
        providerType: ProviderTypeFilter.WASHER,
      });
      return cards[0];
    };

    it('[HP] reports slots left against the cap Admin set', async () => {
      const card = await washerCard({ maxOrdersPerDay: 8 });
      expect(card.slotsRemaining).toBe(8);
    });

    it('[HP] subtracts the day’s used slots from Admin’s cap', async () => {
      const card = await washerCard(
        { maxOrdersPerDay: 8 },
        3,
        OrderStatus.ACCEPTED_BY_PROVIDER,
      );
      expect(card.slotsRemaining).toBe(5);
    });

    it('[EC] a used count past the cap floors at zero', async () => {
      const card = await washerCard(
        { maxOrdersPerDay: 2 },
        9,
        OrderStatus.ACCEPTED_BY_PROVIDER,
      );
      expect(card.slotsRemaining).toBe(0);
    });

    // The cap counter ignores these, so the card must too — a washer whose
    // day is all cancellations still has her whole day free.
    it('[EC] cancelled orders do not consume a slot', async () => {
      const card = await washerCard(
        { maxOrdersPerDay: 8 },
        3,
        OrderStatus.CANCELLED,
      );
      expect(card.slotsRemaining).toBe(8);
    });

    // GAP-H-013: a request she hasn't accepted yet can't lock her out of
    // accepting real work — only accepted-or-beyond orders consume a slot.
    it('[EC] orders still awaiting her decision do not consume a slot', async () => {
      const card = await washerCard(
        { maxOrdersPerDay: 8 },
        3,
        OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
      );
      expect(card.slotsRemaining).toBe(8);
    });

    it('[EC] no cap ⇒ no slots number at all, not an invented ceiling', async () => {
      const card = await washerCard({ maxOrdersPerDay: null });
      expect(card.slotsRemaining).toBeUndefined();
    });

    it('[EC] an uncapped washer still reads as accepting, never "fully booked"', async () => {
      // statusText only falls to the slot wording when she has no operating
      // hours set; with no cap there is no slot arithmetic to report.
      const card = await washerCard({
        maxOrdersPerDay: null,
        operatingHours: null,
        isAvailable: true,
      });
      expect(card.statusText).toBe('Accepting bookings');
    });

    it('[HP] a cap of 1 with an empty day reads as "1 slot left"', async () => {
      const card = await washerCard({
        maxOrdersPerDay: 1,
        operatingHours: null,
        isAvailable: true,
      });
      expect(card.statusText).toBe('1 slot left');
    });
  });

  describe('providerServices', () => {
    it('[HP] returns a washer’s offered templates flagged approved', async () => {
      const t = await templateModel.create({
        name: 'Wash & Fold',
        basePriceCentavos: 25000,
        baseWeightKg: 7,
        excessRatePerKgCentavos: 3000,
        isActive: true,
      });
      const w = await washerModel.create(
        washerDoc({ offeredServiceTemplateIds: [String(t._id)] }),
      );

      const items = await service.providerServices(
        w.branchId,
        ProviderType.WASHER,
      );
      expect(items).toHaveLength(1);
      expect(items[0].approved).toBe(true);
      expect(items[0].pricingType).toBe(PricingType.PER_KILO_WITH_BASE);
      expect(items[0].price).toBe(25000);
    });

    it('[HP] returns a merchant’s active services', async () => {
      const b = await branchModel.create(branchDoc());
      await serviceModel.create({
        uid: 'merch-uid',
        branchId: String(b._id),
        serviceName: 'Wash & Fold',
        price: 6500,
        pricingType: PricingType.PER_KILO,
        category: ServiceCategory.WASH_AND_FOLD,
      });

      const items = await service.providerServices(
        String(b._id),
        ProviderType.MERCHANT,
      );
      expect(items).toHaveLength(1);
      expect(items[0].approved).toBe(false);
      expect(items[0].category).toBe(ServiceCategory.WASH_AND_FOLD);
    });

    it('[EC] excludes a merchant service marked isOnline: false', async () => {
      const b = await branchModel.create(branchDoc());
      await serviceModel.create({
        uid: 'merch-uid',
        branchId: String(b._id),
        serviceName: 'Walk-in Only',
        price: 6500,
        pricingType: PricingType.PER_KILO,
        category: ServiceCategory.WASH_AND_FOLD,
        isOnline: false,
      });

      const items = await service.providerServices(
        String(b._id),
        ProviderType.MERCHANT,
      );
      expect(items).toHaveLength(0);
    });

    it('[EC] includes a merchant service marked isActive: false (isActive gates POS only)', async () => {
      const b = await branchModel.create(branchDoc());
      await serviceModel.create({
        uid: 'merch-uid',
        branchId: String(b._id),
        serviceName: 'Paused In POS',
        price: 6500,
        pricingType: PricingType.PER_KILO,
        category: ServiceCategory.WASH_AND_FOLD,
        isActive: false,
        isOnline: true,
      });

      const items = await service.providerServices(
        String(b._id),
        ProviderType.MERCHANT,
      );
      expect(items).toHaveLength(1);
    });
  });
});
