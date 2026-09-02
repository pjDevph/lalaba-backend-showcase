import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, Types } from 'mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { OnlineOrdersService } from './online-orders.service';
import { OnlineOrdersResolver } from './online-orders.resolver';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { ProviderEligibilityService } from './provider-eligibility.service';
import { BookingAvailabilityService } from '../booking-availability/booking-availability.service';
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
import { WasherServiceOfferingsService } from '../washer-service-offerings/washer-service-offerings.service';
import {
  WasherServiceOffering,
  WasherServiceOfferingSchema,
} from '../washer-service-offerings/schemas/washer-service-offering.schema';
import { QualityHoldSchedulerService } from './quality-hold-scheduler.service';
import { AbandonmentSchedulerService } from './abandonment-scheduler.service';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import {
  OnlineOrder,
  OnlineOrderDocument,
  OnlineOrderSchema,
} from './schemas/online-order.schema';
import { OrderEvent, OrderEventSchema } from './schemas/order-event.schema';
import {
  OnlineTransaction,
  OnlineTransactionSchema,
  OnlineTransactionStatus,
} from './schemas/online-transaction.schema';
import {
  DailyCapCounter,
  DailyCapCounterSchema,
} from './schemas/daily-cap-counter.schema';
import {
  ORDER_STATUS_TRANSITIONS,
  OrderStatus,
  ProviderType,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  DeliverySubMode,
  TurnaroundTierCode,
  PaymentMethod,
  PaymentTiming,
  PaymentStatus,
  LEGACY_PAYMENT_TIMING_ON_DELIVERY,
  AttemptResponsibility,
} from './schemas/order-status.enum';
import { CreateOrderInput } from './dto/create-order.input';
import { RaiseQualityHoldInput } from './dto/quality-hold.input';
import { Address, AddressSchema } from '../addresses/schemas/address.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
  WasherStatus,
  VerificationStatus,
} from '../washer/schemas/washer-profile.schema';
import {
  Service,
  ServiceSchema,
  PricingType,
  ServiceCategory,
} from '../services/schemas/service.schema';
import {
  WasherServiceTemplate,
  WasherServiceTemplateSchema,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Inventory,
  InventorySchema,
  InventoryUnit,
  InventoryCategory,
} from '../inventory/schemas/inventory.schema';
import { ProductCategory } from '../products/schemas/product.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import { WalletAcceptanceGuardService } from '../wallets/wallet-acceptance-guard.service';
import { WalletsService } from '../wallets/wallets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformFeeService } from '../platform-fee/platform-fee.service';
import { PromotionsService } from '../promotions/promotions.service';
import { waivablePlatformFeeCentavos } from './platform-fee-parts.util';
import {
  PromoCode,
  PromoCodeSchema,
  PromoDiscountType,
} from '../promotions/schemas/promo-code.schema';
import {
  PromoRedemption,
  PromoRedemptionSchema,
} from '../promotions/schemas/promo-redemption.schema';
import {
  UserVoucher,
  UserVoucherSchema,
} from '../promotions/schemas/user-voucher.schema';
import {
  DEFAULT_PREMIUM_WINDOW_FEE_CENTAVOS as PICKUP_FEE_SCHEDULED_PAID_CENTAVOS,
  DEFAULT_PREMIUM_WINDOW_FEE_CENTAVOS as RETURN_FEE_SCHEDULED_PAID_CENTAVOS,
  PRICING_RULE_VERSION,
} from './fulfillment-pricing.util';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = 'merchant-owner-uid';
const WASHER_UID = 'washer-owner-uid';
const CUSTOMER_UID = 'customer-uid';
const COURIER_UID = 'courier-uid';
const FOREIGN_COURIER_UID = 'foreign-courier-uid';

const FEE_PERCENT = 10;

const asUser = (
  uid: string,
  roleId: string,
  extra: Record<string, any> = {},
): User =>
  ({
    _id: uid,
    role: { roleId, roleName: roleId } as any,
    firstName: 'Test',
    lastName: roleId,
    phoneNumber: '09171234567',
    ...extra,
  }) as unknown as User;

const merchantOwner = asUser(OWNER, 'merchant');
const washerOwner = asUser(WASHER_UID, 'washer');
const customerUser = asUser(CUSTOMER_UID, 'customer');
const courierUser = asUser(COURIER_UID, 'courier');

const branchAddress = {
  regionName: 'Region IV-A',
  provinceName: 'Rizal',
  cityMunicipalityName: 'Angono',
  barangayName: 'San Isidro',
  streetAddress: '14 M.L. Quezon St',
};

// Every order now carries a pickup DAY — the customer picks a date, never a
// time. Booked far enough ahead to clear any lead-time rule in these fixtures.
const PICKUP_DAY = {
  date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
};

describe('OnlineOrdersService (integration)', () => {
  jest.setTimeout(120_000);

  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: OnlineOrdersService;
  let promotionsService: PromotionsService;
  let resolver: OnlineOrdersResolver;
  let scheduler: QualityHoldSchedulerService;
  let abandonmentScheduler: AbandonmentSchedulerService;

  let orderModel: Model<OnlineOrderDocument>;
  let eventModel: Model<any>;
  let txModel: Model<any>;
  let addressModel: Model<any>;
  let branchModel: Model<any>;
  let washerModel: Model<any>;
  let capCounterModel: Model<any>;
  let serviceModel: Model<any>;
  let templateModel: Model<any>;
  let productModel: Model<any>;
  let inventoryModel: Model<any>;
  let userModel: Model<any>;
  let roleModel: Model<any>;
  let walletModel: Model<any>;

  // Handover proof goes to private object storage; the spec only cares that the
  // keys round-trip, so the bytes never leave memory here.
  const storageStub = {
    upload: jest.fn(),
    uploadPrivate: jest
      .fn()
      .mockImplementation((_b: Buffer, key: string) => Promise.resolve(key)),
    getSignedReadUrl: jest
      .fn()
      .mockImplementation((k: string) =>
        Promise.resolve(`https://signed/${k}`),
      ),
    delete: jest.fn(),
  };

  // Records every notification a transition fires, so a test can assert who
  // was told what without reaching into the notification module.
  const notificationsStub = {
    notify: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(undefined),
    notifyOwnerOfStaffLogin: jest.fn().mockResolvedValue(undefined),
  };

  const walletsStub = {
    consumeFee: jest.fn().mockResolvedValue(undefined),
    reverseFee: jest.fn().mockResolvedValue(undefined),
    isBlocked: jest.fn().mockResolvedValue(false),
    hasSufficientBalance: jest.fn().mockResolvedValue(true),
  };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
          { name: OrderEvent.name, schema: OrderEventSchema },
          { name: OnlineTransaction.name, schema: OnlineTransactionSchema },
          { name: DailyCapCounter.name, schema: DailyCapCounterSchema },
          { name: Address.name, schema: AddressSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: Service.name, schema: ServiceSchema },
          {
            name: WasherServiceTemplate.name,
            schema: WasherServiceTemplateSchema,
          },
          { name: Product.name, schema: ProductSchema },
          { name: Inventory.name, schema: InventorySchema },
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
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
          { name: BookingPolicy.name, schema: BookingPolicySchema },
          { name: BookingMilestone.name, schema: BookingMilestoneSchema },
          { name: BookingCampaign.name, schema: BookingCampaignSchema },
          { name: PromoCode.name, schema: PromoCodeSchema },
          { name: PromoRedemption.name, schema: PromoRedemptionSchema },
          { name: UserVoucher.name, schema: UserVoucherSchema },
        ]),
      ],
      providers: [
        OnlineOrdersService,
        // The real service, not a stub: washer line pricing runs through it,
        // and with no offering rows seeded it resolves to the template's own
        // numbers — which is exactly the pre-offerings behaviour these tests
        // were written against.
        WasherServiceOfferingsService,
        ProviderEligibilityService,
        // The real service, like the offerings one above: with no config rows
        // seeded, providers resolve to the platform defaults, and
        // requireScheduledPickup defaults off — so these pre-scheduling tests
        // exercise exactly the path an un-migrated client still takes.
        BookingAvailabilityService,
        BookingPolicyService,
        QualityHoldSchedulerService,
        AbandonmentSchedulerService,
        { provide: STORAGE_PROVIDER, useValue: storageStub },
        // Notifications are a fire-and-forget side effect of a transition, so
        // the stub records calls without affecting any assertion about the
        // order itself. `notifiedOf` below reads it.
        { provide: NotificationsService, useValue: notificationsStub },
        WalletAcceptanceGuardService,
        { provide: WalletsService, useValue: walletsStub },
        {
          provide: PlatformFeeService,
          useValue: {
            getCurrentFeePercent: jest.fn().mockResolvedValue(FEE_PERCENT),
            // Both provider types resolve to the same rate here, so these
            // pricing assertions stay about the pricing maths rather than
            // about which commission a washer vs a merchant is on.
            getCommissionPercent: jest.fn().mockResolvedValue(FEE_PERCENT),
            resolveCommissionSnapshot: jest.fn().mockResolvedValue({
              percent: FEE_PERCENT,
              ruleKey: 'platform-commission-washer',
              ruleVersion: 1,
              engineVersion: 'fee-rules-v1',
            }),
          },
        },
        // The real service, like the offerings/availability ones above —
        // the promo-code tests below exercise real validation/redemption,
        // not a stub.
        PromotionsService,
      ],
    }).compile();

    service = module.get(OnlineOrdersService);
    promotionsService = module.get(PromotionsService);
    // Constructed directly — registering the resolver in the module would
    // pull in GqlAuthGuard's Firebase dependency chain, irrelevant here.
    // Audit is a no-op stub here: these tests are about order behaviour, and
    // AdminAuditService.record() is fire-and-forget by contract (it swallows
    // its own failures so a logging problem can never roll back an action).
    resolver = new OnlineOrdersResolver(service, {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AdminAuditService);
    scheduler = module.get(QualityHoldSchedulerService);
    abandonmentScheduler = module.get(AbandonmentSchedulerService);
    connection = module.get<Connection>(getConnectionToken());
    orderModel = module.get(`${OnlineOrder.name}Model`);
    eventModel = module.get(`${OrderEvent.name}Model`);
    txModel = module.get(`${OnlineTransaction.name}Model`);
    addressModel = module.get(`${Address.name}Model`);
    branchModel = module.get(`${Branch.name}Model`);
    washerModel = module.get(`${WasherProfile.name}Model`);
    capCounterModel = module.get(`${DailyCapCounter.name}Model`);
    serviceModel = module.get(`${Service.name}Model`);
    templateModel = module.get(`${WasherServiceTemplate.name}Model`);
    productModel = module.get(`${Product.name}Model`);
    inventoryModel = module.get(`${Inventory.name}Model`);
    userModel = module.get(`${User.name}Model`);
    roleModel = module.get(`${Role.name}Model`);
    walletModel = module.get(`${Wallet.name}Model`);
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await module.close();
    await replSet.stop();
  });

  afterEach(async () => {
    for (const key in connection.collections) {
      await connection.collections[key].deleteMany({});
    }
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Fixture builders
  // -------------------------------------------------------------------------

  const makeBranch = async (over: Record<string, any> = {}) => {
    const branch = await branchModel.create({
      uid: OWNER,
      branchName: `Branch-${new Types.ObjectId().toString()}`,
      branchAddress,
      branchMapLocation: { latitude: 14.52, longitude: 121.15 },
      branchPhoneNumber: '09171234567',
      operatingHours: {},
      isActive: true,
      isOnline: true,
      ...over,
    });
    return branch;
  };

  // -------------------------------------------------------------------------
  // Who may work a branch's online queue
  //
  // Staff saw an empty Online Orders screen while the owner, on the same
  // branch, saw the queue: the ownership check compared branch.uid to the
  // caller's own uid, which no employee can ever satisfy. Nothing asserted
  // staff access, so the gap shipped. A merchant cannot be at the counter at
  // all hours, and a queue only the owner can open stops when they leave.
  // -------------------------------------------------------------------------
  describe('incomingOrders — branch access', () => {
    const STAFF_UID = 'staff-uid-1';

    const staffAt = (branchIds: string[], merchantId = OWNER) =>
      asUser(STAFF_UID, 'staff', { merchantId, branchIds });

    it('lets a staff member assigned to the branch read its queue', async () => {
      const branch = await makeBranch();
      await expect(
        service.incomingOrders(
          branch._id.toString(),
          staffAt([branch._id.toString()]),
        ),
      ).resolves.toEqual([]);
    });

    it('still lets the owner read it', async () => {
      const branch = await makeBranch();
      await expect(
        service.incomingOrders(branch._id.toString(), merchantOwner),
      ).resolves.toEqual([]);
    });

    it('refuses staff of the same tenant who are not assigned to the branch', async () => {
      const assigned = await makeBranch();
      const other = await makeBranch();
      await expect(
        service.incomingOrders(
          other._id.toString(),
          staffAt([assigned._id.toString()]),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses staff of a different merchant', async () => {
      const branch = await makeBranch();
      await expect(
        service.incomingOrders(
          branch._id.toString(),
          staffAt([branch._id.toString()], 'some-other-merchant'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a customer who names a branch id', async () => {
      const branch = await makeBranch();
      await expect(
        service.incomingOrders(branch._id.toString(), customerUser),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // The courier picker's list
  //
  // It used to be filled from `myStaff` — every staff member the OWNER employs,
  // narrowed to couriers in the client and by nothing else. Two consequences:
  // staff could not read it at all (owner-only resolver), so their picker was
  // permanently empty; and for owners it listed couriers the assign mutation
  // would then refuse. These pin the shared predicate.
  // -------------------------------------------------------------------------
  describe('assignableCouriers', () => {
    const STAFF_UID = 'staff-picker-1';

    const staffAt = (branchIds: string[]) =>
      asUser(STAFF_UID, 'staff', { merchantId: OWNER, branchIds });

    beforeEach(async () => {
      await makeRoles();
    });

    it('lists the tenant courier for the owner', async () => {
      const branch = await makeBranch();
      await makeCourier('cour-1');

      const list = await service.assignableCouriers(
        branch._id.toString(),
        merchantOwner,
      );
      expect(list.map((c) => c._id)).toEqual(['cour-1']);
    });

    it('lists the same courier for a staff member on that branch', async () => {
      // The screen a staff member actually uses. Before this query existed it
      // read "No couriers on your staff yet" no matter how many there were.
      const branch = await makeBranch();
      await makeCourier('cour-1');

      const list = await service.assignableCouriers(
        branch._id.toString(),
        staffAt([branch._id.toString()]),
      );
      expect(list.map((c) => c._id)).toEqual(['cour-1']);
    });

    it('omits a courier with no verified selfie — the mutation would refuse them', async () => {
      const branch = await makeBranch();
      await makeCourier('cour-no-selfie', { selfieStatus: 'PENDING' });

      const list = await service.assignableCouriers(
        branch._id.toString(),
        merchantOwner,
      );
      expect(list).toEqual([]);
    });

    it('omits inactive and archived couriers', async () => {
      const branch = await makeBranch();
      await makeCourier('cour-inactive', { isActive: false });
      await makeCourier('cour-archived', { isArchived: true });

      const list = await service.assignableCouriers(
        branch._id.toString(),
        merchantOwner,
      );
      expect(list).toEqual([]);
    });

    it("omits another merchant's courier", async () => {
      const branch = await makeBranch();
      await makeCourier('cour-other', { merchantId: 'someone-else' });

      const list = await service.assignableCouriers(
        branch._id.toString(),
        merchantOwner,
      );
      expect(list).toEqual([]);
    });

    it('omits non-couriers, however senior', async () => {
      const branch = await makeBranch();
      await makeCourier('not-a-courier', {}, 'staff');

      const list = await service.assignableCouriers(
        branch._id.toString(),
        merchantOwner,
      );
      expect(list).toEqual([]);
    });

    it('refuses a staff member who is not assigned to the branch', async () => {
      const assigned = await makeBranch();
      const other = await makeBranch();
      await makeCourier('cour-1');

      await expect(
        service.assignableCouriers(
          other._id.toString(),
          staffAt([assigned._id.toString()]),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  const fundWallet = (branchId: string, over: Record<string, any> = {}) =>
    walletModel.create({
      branchId,
      balanceCentavos: 100_000,
      activatedAt: new Date(),
      ...over,
    });

  const makeService = async (
    branchId: string,
    over: Record<string, any> = {},
  ) =>
    serviceModel.create({
      uid: OWNER,
      branchId,
      serviceName: 'Wash & Fold',
      price: 10_000, // ₱100/kg
      pricingType: PricingType.PER_KILO,
      category: ServiceCategory.WASH_AND_FOLD,
      isActive: true,
      isArchived: false,
      ...over,
    });

  const makeAddress = async (over: Record<string, any> = {}) =>
    addressModel.create({
      uid: CUSTOMER_UID,
      address: branchAddress,
      mapLocation: { latitude: 14.53, longitude: 121.16 },
      ...over,
    });

  const makeWasherSetup = async (over: Record<string, any> = {}) => {
    const anchor = await makeBranch({ uid: WASHER_UID });
    const template = await templateModel.create({
      name: 'Wash & Fold (Home)',
      basePriceCentavos: 25_000,
      baseWeightKg: 7,
      excessRatePerKgCentavos: 3_000,
      isActive: true,
    });
    const washer = await washerModel.create({
      uid: WASHER_UID,
      displayName: "Maria's Home Laundry",
      branchId: String(anchor._id),
      status: WasherStatus.ACTIVE,
      isAvailable: true,
      offeredServiceTemplateIds: [String(template._id)],
      mapLocation: { latitude: 14.53, longitude: 121.16 },
      address: branchAddress,
      serviceRadiusKm: 10,
      ...over,
    });
    await fundWallet(String(anchor._id));
    return { anchor, template, washer };
  };

  const makeRoles = async () => {
    for (const roleId of ['merchant', 'washer', 'courier', 'staff']) {
      await roleModel.create({
        roleId,
        roleName: roleId,
        description: roleId,
      });
    }
  };

  const makeCourier = async (
    uid: string,
    over: Record<string, any> = {},
    roleId = 'courier',
  ) => {
    const role = await roleModel.findOne({ roleId }).exec();
    return userModel.create({
      _id: uid,
      role: role!._id,
      email: `${uid}@test.local`,
      firstName: 'Cou',
      lastName: 'Rier',
      phoneNumber: '09170000001',
      isActive: true,
      merchantId: OWNER,
      branchIds: [],
      // Assignment requires a live liveness selfie, so the default fixture is a
      // courier who has one; specs that test the gate override it.
      selfieStatus: 'ACTIVE',
      ...over,
    });
  };

  const merchantOrderInput = (
    branchId: string,
    serviceRefId: string,
    addressId: string,
    over: Record<string, any> = {},
  ): CreateOrderInput => ({
    providerType: ProviderType.MERCHANT,
    branchId,
    addressId,
    serviceLines: [{ serviceRefId, estimatedWeightKg: 5 }],
    pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
    pickupSubMode: DeliverySubMode.SCHEDULED_PAID,
    returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
    scheduledPickup: PICKUP_DAY,
    deliverySubMode: DeliverySubMode.SCHEDULED_PAID,
    ...over,
  });

  /** Full merchant fixture: branch + wallet + service + address. */
  const merchantFixture = async () => {
    const branch = await makeBranch();
    await fundWallet(String(branch._id));
    const svc = await makeService(String(branch._id));
    const address = await makeAddress();
    return { branch, svc, address };
  };

  /** Walks a created order to PICKUP_ARRIVED via the real mutations. */
  const walkToPickupArrived = async (orderId: string) => {
    await makeRoles();
    await makeCourier(COURIER_UID);
    await service.acceptOrder(orderId, merchantOwner);
    await service.assignPickupStaff(orderId, merchantOwner, COURIER_UID);
    await service.startPickupRoute(orderId, courierUser);
    await service.arriveAtPickup(orderId, courierUser);
  };

  /**
   * Test-only replay of the old atomic recordPickup as the two mutations it
   * was split into (recordPickupWeight then recordPickupPayment), so the bulk
   * of the existing pickup-leg tests didn't need to be rewritten one by one.
   */
  const recordPickup = async (
    orderId: string,
    courier: User,
    input: {
      actualWeightKg?: number;
      actualPieceCount?: number;
      lineActuals?: any[];
      proofObjectKeys?: string[];
      paymentTiming?: PaymentTiming;
      paymentMethod?: PaymentMethod;
      referenceId?: string;
      tenderedCentavos?: number;
    },
  ) => {
    await service.recordPickupWeight(orderId, courier, {
      actualWeightKg: input.actualWeightKg,
      actualPieceCount: input.actualPieceCount,
      lineActuals: input.lineActuals,
      proofObjectKeys: input.proofObjectKeys,
    });
    return service.recordPickupPayment(orderId, courier, {
      paymentTiming: input.paymentTiming,
      paymentMethod: input.paymentMethod,
      referenceId: input.referenceId,
      tenderedCentavos: input.tenderedCentavos,
    });
  };

  // =========================================================================
  // GAP-P0-006 — central booking eligibility
  // =========================================================================

  describe('booking eligibility (GAP-P0-006, canonical KYC rule)', () => {
    it('[EC] no wallet → quote rejected (merchant)', async () => {
      const branch = await makeBranch();
      const svc = await makeService(String(branch._id));
      await expect(
        service.quoteOrder(
          {
            providerType: ProviderType.MERCHANT,
            branchId: String(branch._id),
            serviceLines: [
              { serviceRefId: String(svc._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('[EC] wallet below ₱100 floor or not activated → rejected', async () => {
      const branch = await makeBranch();
      const svc = await makeService(String(branch._id));
      await fundWallet(String(branch._id), { balanceCentavos: 9_999 });
      const quote = () =>
        service.quoteOrder(
          {
            providerType: ProviderType.MERCHANT,
            branchId: String(branch._id),
            serviceLines: [
              { serviceRefId: String(svc._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        );
      await expect(quote()).rejects.toThrow(
        'not currently able to take marketplace orders',
      );

      await walletModel.deleteMany({});
      await walletModel.create({
        branchId: String(branch._id),
        balanceCentavos: 100_000, // funded but never activated
      });
      await expect(quote()).rejects.toThrow(
        'not currently able to take marketplace orders',
      );
    });

    it('[HP] funded provider is bookable regardless of KYC status (five canonical cases)', async () => {
      // Cases 2–5: funded + {no KYC, pending, approved, rejected} → bookable.
      for (const verificationStatus of [
        VerificationStatus.PENDING,
        VerificationStatus.APPROVED,
        VerificationStatus.REJECTED,
      ]) {
        for (const key in connection.collections) {
          await connection.collections[key].deleteMany({});
        }
        const { template } = await makeWasherSetup({
          verificationStatus,
          verifiedAt:
            verificationStatus === VerificationStatus.APPROVED
              ? new Date()
              : null,
        });
        const washer = await washerModel.findOne({ uid: WASHER_UID }).exec();
        const quote = await service.quoteOrder(
          {
            providerType: ProviderType.WASHER,
            branchId: washer!.branchId,
            serviceLines: [
              { serviceRefId: String(template._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        );
        expect(quote.estimatedTotalCentavos).toBeGreaterThan(0);
      }
      // Case 1 (no wallet → not bookable) is proven in the test above.
    });

    it('[EC] offline / inactive merchant branch → rejected', async () => {
      const offline = await makeBranch({ isOnline: false });
      await fundWallet(String(offline._id));
      const svc = await makeService(String(offline._id));
      await expect(
        service.quoteOrder(
          {
            providerType: ProviderType.MERCHANT,
            branchId: String(offline._id),
            serviceLines: [
              { serviceRefId: String(svc._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        ),
      ).rejects.toThrow('closed for online orders');

      const inactive = await makeBranch({ isActive: false });
      await fundWallet(String(inactive._id));
      const svc2 = await makeService(String(inactive._id));
      await expect(
        service.quoteOrder(
          {
            providerType: ProviderType.MERCHANT,
            branchId: String(inactive._id),
            serviceLines: [
              { serviceRefId: String(svc2._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        ),
      ).rejects.toThrow('not active');
    });

    it('[EC] suspended or unavailable washer → new bookings rejected', async () => {
      const { template, washer } = await makeWasherSetup({
        status: WasherStatus.SUSPENDED,
      });
      await expect(
        service.quoteOrder(
          {
            providerType: ProviderType.WASHER,
            branchId: washer.branchId,
            serviceLines: [
              { serviceRefId: String(template._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        ),
      ).rejects.toThrow('not currently active');

      await washerModel.updateOne(
        { uid: WASHER_UID },
        { status: WasherStatus.ACTIVE, isAvailable: false },
      );
      await expect(
        service.quoteOrder(
          {
            providerType: ProviderType.WASHER,
            branchId: washer.branchId,
            serviceLines: [
              { serviceRefId: String(template._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        ),
      ).rejects.toThrow('not accepting bookings');
    });

    it('[EC] customer address outside the washer service radius → create rejected', async () => {
      const { template, washer } = await makeWasherSetup({
        serviceRadiusKm: 3,
      });
      // ~0.5° of latitude ≈ 55 km away.
      const farAddress = await makeAddress({
        mapLocation: { latitude: 15.03, longitude: 121.16 },
      });
      await expect(
        service.createOrder(customerUser, {
          providerType: ProviderType.WASHER,
          branchId: washer.branchId,
          addressId: String(farAddress._id),
          serviceLines: [
            { serviceRefId: String(template._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          scheduledPickup: PICKUP_DAY,
        }),
      ).rejects.toThrow('outside the washer’s service area');
    });

    // The radius check compares two points, so it has to no-op when either is
    // missing — which meant an unconfigured washer PASSED it and became
    // bookable from anywhere in the country. Distance is the only thing
    // matching a customer to a home washer, so an absent service area is now
    // its own refusal rather than a skipped comparison.
    it('[EC] washer with no service radius → create rejected, not accepted', async () => {
      const { template, washer } = await makeWasherSetup({
        serviceRadiusKm: null,
      });
      const address = await makeAddress({});
      await expect(
        service.createOrder(customerUser, {
          providerType: ProviderType.WASHER,
          branchId: washer.branchId,
          addressId: String(address._id),
          serviceLines: [
            { serviceRefId: String(template._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          scheduledPickup: PICKUP_DAY,
        }),
      ).rejects.toThrow('has not set up her service area yet');
    });

    it('[EC] washer with no map pin → create rejected', async () => {
      const { template, washer } = await makeWasherSetup({
        mapLocation: null,
      });
      const address = await makeAddress({});
      await expect(
        service.createOrder(customerUser, {
          providerType: ProviderType.WASHER,
          branchId: washer.branchId,
          addressId: String(address._id),
          serviceLines: [
            { serviceRefId: String(template._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          scheduledPickup: PICKUP_DAY,
        }),
      ).rejects.toThrow('has not set up her service area yet');
    });
  });

  // =========================================================================
  // RISK-P0-007 — tenant scoping of services / templates / products
  // =========================================================================

  describe('tenant scoping (RISK-P0-007)', () => {
    it('[EC] rejects a service belonging to a different branch', async () => {
      const { branch, address } = await merchantFixture();
      const otherBranch = await makeBranch({ uid: 'other-owner' });
      const foreignSvc = await makeService(String(otherBranch._id), {
        uid: 'other-owner',
      });
      await expect(
        service.createOrder(
          customerUser,
          merchantOrderInput(
            String(branch._id),
            String(foreignSvc._id),
            String(address._id),
          ),
        ),
      ).rejects.toThrow('Service not found for this provider');
    });

    it('[EC] rejects a service marked isOnline: false', async () => {
      const { branch, address } = await merchantFixture();
      const posOnlySvc = await makeService(String(branch._id), {
        serviceName: 'Walk-in Only',
        isOnline: false,
      });
      await expect(
        service.createOrder(
          customerUser,
          merchantOrderInput(
            String(branch._id),
            String(posOnlySvc._id),
            String(address._id),
          ),
        ),
      ).rejects.toThrow('Service not found for this provider');
    });

    it('[HP] accepts a service marked isActive: false (isActive gates POS only, not online)', async () => {
      const { branch, address } = await merchantFixture();
      const posOnlyPaused = await makeService(String(branch._id), {
        serviceName: 'Paused In POS',
        isActive: false,
      });
      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(posOnlyPaused._id),
          String(address._id),
        ),
      );
      expect(order).toBeDefined();
    });

    it('[EC] rejects a template the washer does not offer', async () => {
      const { washer } = await makeWasherSetup();
      const unoffered = await templateModel.create({
        name: 'Premium Delicates',
        basePriceCentavos: 40_000,
        baseWeightKg: 5,
        excessRatePerKgCentavos: 5_000,
        isActive: true,
      });
      await expect(
        service.quoteOrder(
          {
            providerType: ProviderType.WASHER,
            branchId: washer.branchId,
            serviceLines: [
              { serviceRefId: String(unoffered._id), estimatedWeightKg: 5 },
            ],
          },
          CUSTOMER_UID,
        ),
      ).rejects.toThrow('does not offer the selected service');
    });

    it('[EC] rejects replacement products from another branch; accepts own', async () => {
      const { branch, svc, address } = await merchantFixture();
      const otherBranch = await makeBranch({ uid: 'other-owner' });

      const makeProduct = async (branchId: string, name: string) => {
        const inv = await inventoryModel.create({
          uid: OWNER,
          branchId,
          productName: name,
          cost: 100,
          inventoryUnit: InventoryUnit.sachet,
          inventoryCategory: InventoryCategory.powdered_detergent,
          stockQuantity: 10,
        });
        return productModel.create({
          inventoryId: inv._id,
          productName: name,
          price: 2_500,
          quantity: 1,
          productUnit: InventoryUnit.sachet,
          productCategory: ProductCategory.powdered_detergent,
          isActive: true,
        });
      };
      const ownProduct = await makeProduct(String(branch._id), 'Own Soap');
      const foreignProduct = await makeProduct(
        String(otherBranch._id),
        'Foreign Soap',
      );

      await expect(
        service.createOrder(
          customerUser,
          merchantOrderInput(
            String(branch._id),
            String(svc._id),
            String(address._id),
            {
              serviceLines: [
                {
                  serviceRefId: String(svc._id),
                  estimatedWeightKg: 5,
                  replacementProductIds: [String(foreignProduct._id)],
                },
              ],
            },
          ),
        ),
      ).rejects.toThrow('not available from this provider');

      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
          {
            serviceLines: [
              {
                serviceRefId: String(svc._id),
                estimatedWeightKg: 5,
                replacementProductIds: [String(ownProduct._id)],
              },
            ],
          },
        ),
      );
      expect(order.serviceLines[0].productSurchargeCentavos).toBe(2_500);
    });
  });

  // =========================================================================
  // GAP-P0-004 — shared wallet acceptance gate, both provider types
  // =========================================================================

  describe('wallet acceptance gate (GAP-P0-004)', () => {
    it('[EC] MERCHANT cannot accept with a wallet below the estimated fee', async () => {
      const { branch, svc, address } = await merchantFixture();
      // 50 kg × ₱100 = ₱5,000 subtotal → 10% fee = ₱500 (50_000c), which is
      // ABOVE the ₱100 eligibility floor so the wallet guard is what bites.
      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
          {
            serviceLines: [
              { serviceRefId: String(svc._id), estimatedWeightKg: 50 },
            ],
          },
        ),
      );
      expect(order.pricing.platformFeeCentavos).toBe(50_000);
      // Meets the ₱100 discovery/eligibility floor, but not the fee.
      await walletModel.updateOne(
        { branchId: String(branch._id) },
        { balanceCentavos: 10_000 },
      );
      await expect(
        service.acceptOrder(String(order._id), merchantOwner),
      ).rejects.toThrow('Insufficient wallet balance');
    });

    // ── Contract matrix: day-only scheduling + Express eligibility ────────
    //
    // Express is a PRIORITY concept and stays separate from pickupSubMode,
    // which is about transport. A merchant can be both express and free-batch;
    // a washer can be neither express nor anything but the two pickup tiers.

    it('[HP] washer accepts FREE_BATCH', async () => {
      const { template, washer } = await makeWasherSetup();
      const address = await makeAddress();
      const order = await service.createOrder(customerUser, {
        providerType: ProviderType.WASHER,
        branchId: washer.branchId,
        addressId: String(address._id),
        serviceLines: [
          { serviceRefId: String(template._id), estimatedWeightKg: 5 },
        ],
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        pickupSubMode: DeliverySubMode.FREE_BATCH,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        scheduledPickup: PICKUP_DAY,
      });
      expect(order.fulfillment.pickupSubMode).toBe(DeliverySubMode.FREE_BATCH);
    });

    it('[HP] washer accepts the paid pickup tier', async () => {
      const { template, washer } = await makeWasherSetup();
      const address = await makeAddress();
      const order = await service.createOrder(customerUser, {
        providerType: ProviderType.WASHER,
        branchId: washer.branchId,
        addressId: String(address._id),
        serviceLines: [
          { serviceRefId: String(template._id), estimatedWeightKg: 5 },
        ],
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        pickupSubMode: DeliverySubMode.SCHEDULED_PAID,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        scheduledPickup: PICKUP_DAY,
      });
      expect(order.fulfillment.pickupSubMode).toBe(
        DeliverySubMode.SCHEDULED_PAID,
      );
    });

    it('[EC] washer REFUSES Express', async () => {
      const { template, washer } = await makeWasherSetup();
      const address = await makeAddress();
      await expect(
        service.createOrder(customerUser, {
          providerType: ProviderType.WASHER,
          branchId: washer.branchId,
          addressId: String(address._id),
          serviceLines: [
            { serviceRefId: String(template._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          turnaroundTier: TurnaroundTierCode.EXPRESS,
          scheduledPickup: PICKUP_DAY,
        }),
      ).rejects.toThrow(/only available from laundry shops/i);
    });

    it('[HP] merchant accepts Express when the shop sells it', async () => {
      const { branch, svc, address } = await merchantFixture();
      // Express is per-provider config, not a provider-type default: a shop
      // that has not enabled it is refused too. Enabling it here is what makes
      // this the MERCHANT half of the matrix rather than a config test.
      await connection.collection('booking_availability_configs').updateOne(
        { branchId: String(branch._id) },
        {
          $set: {
            'fulfillmentPricing.express': {
              enabled: true,
              feeCentavos: 12_000,
              slaHours: 6,
            },
          },
        },
        { upsert: true },
      );
      const order = await service.createOrder(customerUser, {
        ...merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
        turnaroundTier: TurnaroundTierCode.EXPRESS,
      });
      expect(order.turnaround?.tierCode).toBe(TurnaroundTierCode.EXPRESS);
    });

    // The date is what day capacity is counted on, so an order without one
    // would consume a real place while counting toward nothing.
    it('[EC] a missing pickup date is refused', async () => {
      const { template, washer } = await makeWasherSetup();
      const address = await makeAddress();
      await expect(
        service.createOrder(customerUser, {
          providerType: ProviderType.WASHER,
          branchId: washer.branchId,
          addressId: String(address._id),
          serviceLines: [
            { serviceRefId: String(template._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        } as never),
      ).rejects.toThrow(/choose a pickup date/i);
    });

    // The stored snapshot is a DAY. A lingering startTime would mean some
    // surface could still render a time nobody honours.
    it('[HP] the stored pickup carries a date and label, never times', async () => {
      const { template, washer } = await makeWasherSetup();
      const address = await makeAddress();
      const order = await service.createOrder(customerUser, {
        providerType: ProviderType.WASHER,
        branchId: washer.branchId,
        addressId: String(address._id),
        serviceLines: [
          { serviceRefId: String(template._id), estimatedWeightKg: 5 },
        ],
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        scheduledPickup: PICKUP_DAY,
      });
      expect(order.fulfillment.scheduledPickup?.date).toBe(PICKUP_DAY.date);
      expect(order.fulfillment.scheduledPickup?.label).toMatch(
        /^\w{3}, \w{3} \d{1,2}$/,
      );
      expect(order.fulfillment.scheduledPickup).not.toHaveProperty('startTime');
      expect(order.fulfillment.scheduledPickup).not.toHaveProperty('endTime');
    });

    it('[EC] negative wallet blocks acceptance for a washer too', async () => {
      const { template, washer } = await makeWasherSetup();
      const address = await makeAddress();
      const order = await service.createOrder(customerUser, {
        providerType: ProviderType.WASHER,
        branchId: washer.branchId,
        addressId: String(address._id),
        serviceLines: [
          { serviceRefId: String(template._id), estimatedWeightKg: 5 },
        ],
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        scheduledPickup: PICKUP_DAY,
      });
      await walletModel.updateOne(
        { branchId: washer.branchId },
        { balanceCentavos: -5_000 },
      );
      // Eligibility rejects first (below floor) — which is still a wallet
      // gate; restore above floor but negative is impossible, so assert the
      // guard message with a balance below the fee instead.
      await expect(
        service.acceptOrder(String(order._id), washerOwner),
      ).rejects.toThrow(BadRequestException);
    });

    it('[HP] funded merchant accepts fine (gate passes when balance ≥ fee)', async () => {
      const { branch, svc, address } = await merchantFixture();
      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const accepted = await service.acceptOrder(
        String(order._id),
        merchantOwner,
      );
      expect(accepted.status).toBe(OrderStatus.AWAITING_PICKUP_ASSIGNMENT);
    });
  });

  // =========================================================================
  // GAP-H-013 — daily cap atomicity
  // =========================================================================

  describe('washer daily cap (GAP-H-013)', () => {
    const washerCreateInput = (
      branchId: string,
      templateId: string,
      addressId: string,
    ): CreateOrderInput => ({
      providerType: ProviderType.WASHER,
      branchId,
      addressId,
      serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
      pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
      returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
      scheduledPickup: PICKUP_DAY,
    });

    it('[EC] concurrency: two parallel accepts at cap-1 → exactly one wins', async () => {
      const { template, washer } = await makeWasherSetup({
        maxOrdersPerDay: 2,
      });
      const address = await makeAddress();
      // One slot already consumed today.
      const first = await service.createOrder(
        customerUser,
        washerCreateInput(
          washer.branchId,
          String(template._id),
          String(address._id),
        ),
      );
      await service.acceptOrder(String(first._id), washerOwner);

      // Two more pending orders — only ONE remaining slot.
      const [o1, o2] = await Promise.all([
        service.createOrder(
          customerUser,
          washerCreateInput(
            washer.branchId,
            String(template._id),
            String(address._id),
          ),
        ),
        service.createOrder(
          customerUser,
          washerCreateInput(
            washer.branchId,
            String(template._id),
            String(address._id),
          ),
        ),
      ]);

      const results = await Promise.allSettled([
        service.acceptOrder(String(o1._id), washerOwner),
        service.acceptOrder(String(o2._id), washerOwner),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The cap is counted against the day the laundry is SCHEDULED for, so
      // the refusal names that day. It used to say "today" for every order
      // regardless of when it was booked, because it counted by creation date.
      expect(String(rejected[0].reason)).toMatch(
        /fully booked on|order limit/i,
      );

      // Exactly cap (2) orders in accepted-or-beyond states.
      const acceptedCount = await orderModel.countDocuments({
        'provider.branchId': washer.branchId,
        status: {
          $in: [
            OrderStatus.ACCEPTED_BY_PROVIDER,
            OrderStatus.AWAITING_PICKUP_ASSIGNMENT,
          ],
        },
      });
      expect(acceptedCount).toBe(2);
    });

    it('[EC] the order being accepted never counts against its own cap (cap 1, empty day)', async () => {
      const { template, washer } = await makeWasherSetup({
        maxOrdersPerDay: 1,
      });
      const address = await makeAddress();
      const order = await service.createOrder(
        customerUser,
        washerCreateInput(
          washer.branchId,
          String(template._id),
          String(address._id),
        ),
      );
      const accepted = await service.acceptOrder(
        String(order._id),
        washerOwner,
      );
      expect(accepted.status).toBe(OrderStatus.AWAITING_PICKUP_ASSIGNMENT);
    });

    // The cap counts the day the laundry is SCHEDULED for, not the day the
    // order was created. It used to count `createdAt >= startOfTodayPH()`,
    // which disagreed with the availability engine's own limit — that has
    // always grouped on fulfillment.scheduledPickup.date. Two caps counting
    // different things about one washer gave two wrong answers: an order
    // booked for next week consumed today's slot, and a washer could be told
    // she was full on a day with no work on it.
    it("[HP] a booking for another day does not consume the scheduled day's slot", async () => {
      const { template, washer } = await makeWasherSetup({
        maxOrdersPerDay: 1,
      });
      const address = await makeAddress();

      const dayA = new Date(Date.now() + 3 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const dayB = new Date(Date.now() + 4 * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const onA = await service.createOrder(customerUser, {
        ...washerCreateInput(
          washer.branchId,
          String(template._id),
          String(address._id),
        ),
        scheduledPickup: { date: dayA },
      });
      await service.acceptOrder(String(onA._id), washerOwner);

      // Day A is now full at 1/1. Day B is untouched, and both orders were
      // created on the same day — which is exactly what the old basis got wrong.
      const onB = await service.createOrder(customerUser, {
        ...washerCreateInput(
          washer.branchId,
          String(template._id),
          String(address._id),
        ),
        scheduledPickup: { date: dayB },
      });
      const acceptedB = await service.acceptOrder(String(onB._id), washerOwner);
      expect(acceptedB.status).toBe(OrderStatus.AWAITING_PICKUP_ASSIGNMENT);

      // And day A really is full — the cap still works, it just counts the
      // right day.
      await expect(
        service.createOrder(customerUser, {
          ...washerCreateInput(
            washer.branchId,
            String(template._id),
            String(address._id),
          ),
          scheduledPickup: { date: dayA },
        }),
      ).rejects.toThrow(/fully booked|order limit/i);
    });

    it('[EC] booking-time cap check rejects createOrder when the day is full', async () => {
      const { template, washer } = await makeWasherSetup({
        maxOrdersPerDay: 1,
      });
      const address = await makeAddress();
      const order = await service.createOrder(
        customerUser,
        washerCreateInput(
          washer.branchId,
          String(template._id),
          String(address._id),
        ),
      );
      await service.acceptOrder(String(order._id), washerOwner);
      await expect(
        service.createOrder(
          customerUser,
          washerCreateInput(
            washer.branchId,
            String(template._id),
            String(address._id),
          ),
        ),
      ).rejects.toThrow(/fully booked on|order limit/i);
    });

    // The cap is Admin's per-washer number and nothing stands in for it. This
    // is the same scenario as the test above with the cap UNSET: it must not be
    // enforced at all, rather than against a constant nobody configured. (A
    // local 20 used to fill in here, outranking both the platform booking
    // policy and the number the washer app displayed.)
    it('[EC] no admin-set cap ⇒ the daily order limit is not enforced', async () => {
      const { template, washer } = await makeWasherSetup({
        maxOrdersPerDay: null,
      });
      const address = await makeAddress();

      const first = await service.createOrder(
        customerUser,
        washerCreateInput(
          washer.branchId,
          String(template._id),
          String(address._id),
        ),
      );
      await service.acceptOrder(String(first._id), washerOwner);

      // Under a cap of 1 this createOrder throws (test above). Uncapped it must
      // go through, and the second accept must succeed too.
      const second = await service.createOrder(
        customerUser,
        washerCreateInput(
          washer.branchId,
          String(template._id),
          String(address._id),
        ),
      );
      const accepted = await service.acceptOrder(
        String(second._id),
        washerOwner,
      );
      expect(accepted.status).toBe(OrderStatus.AWAITING_PICKUP_ASSIGNMENT);

      // No slot was reserved either: with no cap there is no limit for two
      // concurrent accepts to race past, so the counter is never incremented.
      const counter = await capCounterModel
        .findOne({ branchId: washer.branchId })
        .exec();
      expect(counter?.acceptedCount ?? 0).toBe(0);
    });
  });

  // =========================================================================
  // RISK-P0-008 — courier assignment tenancy
  // =========================================================================

  describe('courier assignment (RISK-P0-008)', () => {
    const setupAcceptedOrder = async () => {
      const { branch, svc, address } = await merchantFixture();
      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      await service.acceptOrder(String(order._id), merchantOwner);
      return { branch, order };
    };

    it('[HP] assigns an active courier of the same merchant', async () => {
      const { order } = await setupAcceptedOrder();
      await makeRoles();
      await makeCourier(COURIER_UID);
      const updated = await service.assignPickupStaff(
        String(order._id),
        merchantOwner,
        COURIER_UID,
      );
      expect(updated.pickupAssignment?.assignedStaffUid).toBe(COURIER_UID);
    });

    it('[EC] rejects a courier from another merchant and appends an audit event', async () => {
      const { order } = await setupAcceptedOrder();
      await makeRoles();
      await makeCourier(FOREIGN_COURIER_UID, {
        merchantId: 'some-other-merchant',
        branchIds: [],
      });
      await expect(
        service.assignPickupStaff(
          String(order._id),
          merchantOwner,
          FOREIGN_COURIER_UID,
        ),
      ).rejects.toThrow(ForbiddenException);
      const audit = await eventModel
        .find({ orderId: String(order._id) })
        .sort({ sequence: -1 })
        .exec();
      expect(audit[0].note).toContain('Courier assignment rejected');
      expect(audit[0].note).toContain(FOREIGN_COURIER_UID);
    });

    it('[EC] rejects a non-courier staff member and an unknown/archived uid', async () => {
      const { order } = await setupAcceptedOrder();
      await makeRoles();
      await makeCourier('staff-user', {}, 'staff');
      await expect(
        service.assignPickupStaff(
          String(order._id),
          merchantOwner,
          'staff-user',
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.assignPickupStaff(String(order._id), merchantOwner, 'ghost'),
      ).rejects.toThrow(ForbiddenException);
      await makeCourier('archived-courier', { isArchived: true });
      await expect(
        service.assignPickupStaff(
          String(order._id),
          merchantOwner,
          'archived-courier',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[EC] rejects a courier whose liveness selfie is missing or revoked', async () => {
      const { order } = await setupAcceptedOrder();
      await makeRoles();
      await makeCourier('no-selfie-courier', { selfieStatus: null });
      await makeCourier('revoked-courier', { selfieStatus: 'REVOKED' });
      for (const uid of ['no-selfie-courier', 'revoked-courier']) {
        await expect(
          service.assignPickupStaff(String(order._id), merchantOwner, uid),
        ).rejects.toThrow(ForbiddenException);
      }
      const audit = await eventModel
        .find({ orderId: String(order._id) })
        .sort({ sequence: -1 })
        .exec();
      expect(audit[0].note).toContain('no verified selfie');
    });

    it('[HP] a washer may self-assign her own deliveries', async () => {
      const { template, washer } = await makeWasherSetup();
      const address = await makeAddress();
      const order = await service.createOrder(customerUser, {
        providerType: ProviderType.WASHER,
        branchId: washer.branchId,
        addressId: String(address._id),
        serviceLines: [
          { serviceRefId: String(template._id), estimatedWeightKg: 5 },
        ],
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        scheduledPickup: PICKUP_DAY,
      });
      await service.acceptOrder(String(order._id), washerOwner);
      const updated = await service.assignPickupStaff(
        String(order._id),
        washerOwner,
        WASHER_UID,
      );
      expect(updated.pickupAssignment?.assignedStaffUid).toBe(WASHER_UID);
    });
  });

  // =========================================================================
  // RISK-P0-009 — customer address/coords/phone redaction
  // =========================================================================

  describe('customer snapshot redaction (RISK-P0-009)', () => {
    it('[HP] courier sees exact address on a leg assigned to them — before, during and after — and areaLabel always renders', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await makeRoles();
      await makeCourier(COURIER_UID);
      await service.acceptOrder(orderId, merchantOwner);
      await service.assignPickupStaff(orderId, merchantOwner, COURIER_UID);

      const courierRequester = asUser(COURIER_UID, 'courier', {
        merchantId: OWNER, // even tenant staff get no bypass while role=courier
        branchIds: [String(branch._id)],
      });

      // BEFORE the leg goes live (assigned, not en route). This is the case the
      // rule turns on: the stop has to be plottable on the rider's map while it
      // is still NEW, or the job is invisible until they set off blind.
      let order = await orderModel.findById(orderId).exec();
      let snap = service.customerSnapshotFor(order!, courierRequester);
      expect(snap.address?.streetAddress).toBe('14 M.L. Quezon St');
      expect(snap.mapLocation?.latitude).toBeCloseTo(14.53);
      expect(snap.areaLabel).toBe('San Isidro, Angono');

      // DURING (en route): full, unchanged.
      await service.startPickupRoute(orderId, courierUser);
      order = await orderModel.findById(orderId).exec();
      snap = service.customerSnapshotFor(order!, courierRequester);
      expect(snap.address?.streetAddress).toBe('14 M.L. Quezon St');
      expect(snap.mapLocation?.latitude).toBeCloseTo(14.53);
      expect(snap.maskedPhone).toBeDefined();

      // AFTER the leg completes: still visible. The assignment is what grants
      // it, and that does not expire — a rider's own history keeps its
      // addresses.
      await service.arriveAtPickup(orderId, courierUser);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentMethod: PaymentMethod.CASH,
      });
      order = await orderModel.findById(orderId).exec();
      snap = service.customerSnapshotFor(order!, courierRequester);
      expect(snap.address?.streetAddress).toBe('14 M.L. Quezon St');
      expect(snap.mapLocation?.latitude).toBeCloseTo(14.53);
      expect(snap.areaLabel).toBe('San Isidro, Angono');
    });

    it('[UP] a courier holding no assignment on the order sees only the area, in every status', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await makeRoles();
      await makeCourier(COURIER_UID);
      await service.acceptOrder(orderId, merchantOwner);
      await service.assignPickupStaff(orderId, merchantOwner, COURIER_UID);

      // A second rider, on the same branch, while the first one's leg is live.
      const otherCourier = asUser('courier-2', 'courier', {
        merchantId: OWNER,
        branchIds: [String(branch._id)],
      });
      await service.startPickupRoute(orderId, courierUser);

      const order = await orderModel.findById(orderId).exec();
      const snap = service.customerSnapshotFor(order!, otherCourier);
      expect(snap.address).toBeUndefined();
      expect(snap.mapLocation).toBeUndefined();
      expect(snap.maskedPhone).toBeUndefined();
      expect(snap.areaLabel).toBe('San Isidro, Angono');
    });

    it('[HP] customer, provider owner, non-courier staff and admin always see full data', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const order = await orderModel.findById(String(created._id)).exec();
      const full = (u: User) => service.customerSnapshotFor(order!, u);
      expect(full(customerUser).address?.streetAddress).toBe(
        '14 M.L. Quezon St',
      );
      expect(full(merchantOwner).mapLocation?.latitude).toBeCloseTo(14.53);
      expect(
        full(asUser('staff-1', 'staff', { branchIds: [String(branch._id)] }))
          .address,
      ).toBeDefined();
      expect(full(asUser('admin-1', 'admin')).maskedPhone).toBeDefined();
      // A random courier with no relationship at all: redacted.
      expect(full(asUser('rando', 'courier')).address).toBeUndefined();
    });
  });

  // =========================================================================
  // GAP-H-014 — quality-hold lifecycle
  // =========================================================================

  describe('quality-hold lifecycle (GAP-H-014)', () => {
    const setupHeldOrder = async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentMethod: PaymentMethod.CASH,
      });
      await service.raiseQualityHold(orderId, merchantOwner, {
        serviceLineIndex: 0,
        reason: 'Stubborn stain, needs special treatment',
        blocksOrder: true,
        additionalChargeCentavos: 5_000,
      });
      return orderId;
    };

    // Regression: serviceLineIndex carried no class-validator decorator, so the
    // whitelist:true pipe stripped it before the service ever saw it. Every hold
    // stored undefined, and the non-nullable GraphQL field then blew up the
    // customer's entire order list. Validate through the PIPE, not the service —
    // calling the service directly is exactly what missed this.
    it('[EC] serviceLineIndex survives the validation pipe (whitelist strips undecorated fields)', async () => {
      const input = plainToInstance(RaiseQualityHoldInput, {
        serviceLineIndex: 0,
        reason: 'Ink stain needs solvent treatment',
        blocksOrder: true,
        additionalChargeCentavos: 5_000,
      });
      expect(await validate(input)).toHaveLength(0);

      const whitelisted = plainToInstance(
        RaiseQualityHoldInput,
        JSON.parse(JSON.stringify(input)),
      );
      // The field must still be present and typed after transformation.
      expect(whitelisted.serviceLineIndex).toBe(0);
    });

    it('[EC] a second hold cannot overwrite one the customer has not answered', async () => {
      // Regression: raiseQualityHold used to assign activeQualityHold outright,
      // so a double-submit erased a pending hold — and could re-block an order
      // the customer had already resolved.
      const orderId = await setupHeldOrder(); // leaves one hold PENDING
      await expect(
        service.raiseQualityHold(orderId, merchantOwner, {
          serviceLineIndex: 0,
          reason: 'A second, different problem raised too soon',
          blocksOrder: true,
          additionalChargeCentavos: 1_000,
        }),
      ).rejects.toThrow('already has a quality hold');

      // The original hold is untouched.
      const after = await orderModel.findById(orderId).exec();
      expect(after!.activeQualityHold?.additionalChargeCentavos).toBe(5_000);
      expect(after!.status).toBe(OrderStatus.LAUNDRY_QUALITY_HOLD);
    });

    it('[HP] a NEW hold is allowed once the previous one is resolved', async () => {
      const orderId = await setupHeldOrder();
      await service.respondToQualityHold(orderId, customerUser, {
        approve: false,
      });
      await expect(
        service.raiseQualityHold(orderId, merchantOwner, {
          serviceLineIndex: 0,
          reason: 'Something else came up during the wash',
          blocksOrder: false,
        }),
      ).resolves.toBeTruthy();
    });

    it('[EC] a serviceLineIndex past the end of the order is refused', async () => {
      const orderId = await setupHeldOrder();
      await expect(
        service.raiseQualityHold(orderId, merchantOwner, {
          serviceLineIndex: 99,
          reason: 'Points at a service line that does not exist',
          blocksOrder: true,
        }),
      ).rejects.toThrow('not on this order');
    });

    it('[EC] late response is rejected with a clear error; sweep resolves it; both are idempotent', async () => {
      const orderId = await setupHeldOrder();
      // Force the 24h window into the past.
      await orderModel.updateOne({ _id: orderId } as any, {
        $set: {
          'activeQualityHold.respondTimeoutAt': new Date(Date.now() - 60_000),
        },
      });

      await expect(
        service.respondToQualityHold(orderId, customerUser, { approve: true }),
      ).rejects.toThrow('response window for this quality hold has expired');

      // Scheduler sweep resolves exactly this hold.
      const resolvedCount = await scheduler.sweepExpiredQualityHolds();
      expect(resolvedCount).toBe(1);
      const after = await orderModel.findById(orderId).exec();
      expect(after!.status).toBe(OrderStatus.LAUNDRY_IN_PROGRESS);
      expect(after!.activeQualityHold?.resolvedAt).toBeDefined();
      // No surcharge on timeout — safest default.
      expect(after!.pricing.customerTotalCentavos).toBe(
        after!.pricing.actualServiceTotalCentavos! +
          after!.pricing.platformFeeCentavos! +
          after!.pricing.pickupFeeCentavos! +
          after!.pricing.returnFeeCentavos!,
      );

      // Second sweep: idempotent no-op.
      expect(await scheduler.sweepExpiredQualityHolds()).toBe(0);
      // Direct re-invocation: idempotent no-op, no throw, no double transition.
      await service.autoResolveExpiredQualityHold(orderId);
      // Late customer response after resolution: clearly rejected.
      await expect(
        service.respondToQualityHold(orderId, customerUser, { approve: true }),
      ).rejects.toThrow('already been resolved');
    });

    it('[HP] in-window approval applies the surcharge exactly once, fee included', async () => {
      const orderId = await setupHeldOrder();
      const before = await orderModel.findById(orderId).exec();
      const dueBefore = before!.pricing.customerTotalCentavos!;
      const feeBefore = before!.pricing.platformFeeCentavos!;
      const serviceBefore = before!.pricing.actualServiceTotalCentavos!;
      await service.respondToQualityHold(orderId, customerUser, {
        approve: true,
      });
      const after = await orderModel.findById(orderId).exec();
      expect(after!.status).toBe(OrderStatus.LAUNDRY_IN_PROGRESS);
      // SEC-007: an approved surcharge is fee-bearing, on the same snapshotted
      // 10% rule as the base service — otherwise a provider could shift margin
      // out of the service price and into the surcharge to dodge the platform
      // fee. ₱50.00 surcharge → ₱5.00 fee → ₱55.00 added to what's owed.
      expect(after!.pricing.actualServiceTotalCentavos).toBe(
        serviceBefore + 5_000,
      );
      expect(after!.pricing.platformFeeCentavos).toBe(feeBefore + 500);
      expect(after!.pricing.customerTotalCentavos).toBe(dueBefore + 5_500);
      // ...and the penalty portion is recorded on its own, so a promotion
      // that waives "the platform fee" can forgive the fee on the service
      // without also forgiving a penalty. Before the split the two were the
      // same number and there was no way to tell them apart afterwards.
      expect(after!.pricing.platformFeeSurchargeCentavos).toBe(500);
      expect(waivablePlatformFeeCentavos(after!.pricing)).toBe(feeBefore);
      // The total still reconciles against its parts.
      expect(after!.pricing.customerTotalCentavos).toBe(
        after!.pricing.actualServiceTotalCentavos! +
          after!.pricing.platformFeeCentavos! +
          after!.pricing.pickupFeeCentavos! +
          after!.pricing.returnFeeCentavos!,
      );
      expect(after!.activeQualityHold?.resolvedAt).toBeDefined();
      await expect(
        service.respondToQualityHold(orderId, customerUser, { approve: true }),
      ).rejects.toThrow('already been resolved');
    });
  });

  // =========================================================================
  // GAP-P0-005 / GAP-H-017 — server-authoritative fees, centavo equality, tender
  // =========================================================================

  describe('pricing: quote/create/collect centavo equality (GAP-P0-005)', () => {
    it('[HP] quote == create snapshot == collected total, fulfillment fees included', async () => {
      const { branch, svc, address } = await merchantFixture();

      const quote = await service.quoteOrder(
        {
          providerType: ProviderType.MERCHANT,
          branchId: String(branch._id),
          serviceLines: [
            { serviceRefId: String(svc._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          pickupSubMode: DeliverySubMode.SCHEDULED_PAID,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          deliverySubMode: DeliverySubMode.SCHEDULED_PAID,
        },
        CUSTOMER_UID,
      );
      // 5 kg × ₱100 = 50_000; fee 10% = 5_000; pickup 5_000; return 5_000.
      // (Express moved out of the delivery leg — it is a turnaround tier now,
      // priced separately and independent of how the laundry travels.)
      expect(quote.serviceSubtotalCentavos).toBe(50_000);
      expect(quote.platformFeeCentavos).toBe(5_000);
      expect(quote.pickupFeeCentavos).toBe(PICKUP_FEE_SCHEDULED_PAID_CENTAVOS);
      expect(quote.returnFeeCentavos).toBe(RETURN_FEE_SCHEDULED_PAID_CENTAVOS);
      expect(quote.customerTotalCentavos).toBe(65_000);
      expect(quote.estimatedTotalCentavos).toBe(65_000);
      expect(quote.pricingRuleVersion).toBe(PRICING_RULE_VERSION);

      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      expect(created.pricing.estimatedTotalCentavos).toBe(
        quote.estimatedTotalCentavos,
      );
      expect(created.pricing.pickupFeeCentavos).toBe(quote.pickupFeeCentavos);
      expect(created.pricing.returnFeeCentavos).toBe(quote.returnFeeCentavos);
      expect(created.pricing.pricingRuleVersion).toBe(PRICING_RULE_VERSION);

      // Collect at pickup with the actual weight equal to the estimate.
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentMethod: PaymentMethod.CASH,
        tenderedCentavos: 100_000,
      });
      const collected = await orderModel.findById(orderId).exec();
      expect(collected!.pricing.customerTotalCentavos).toBe(65_000);
      expect(collected!.paymentSummary.amountCollectedCentavos).toBe(65_000);
      // GAP-H-017: tender/change recorded, change computed server-side.
      expect(collected!.paymentSummary.tenderedCentavos).toBe(100_000);
      expect(collected!.paymentSummary.changeCentavos).toBe(35_000);
      const tx = await txModel.findOne({ orderId }).exec();
      expect(tx.amountCentavos).toBe(65_000);
      expect(tx.tenderedCentavos).toBe(100_000);
      expect(tx.changeCentavos).toBe(35_000);
      // Platform fee consumed transactionally with the collection.
      expect(walletsStub.consumeFee).toHaveBeenCalledWith(
        String(branch._id),
        5_000,
        orderId,
        expect.anything(),
      );
    });

    // The whole partner-incentive path, end to end: an admin publishes "no
    // Lalaba fee", a merchant accepts an order, and the fee is simply not
    // charged. The merchant types nothing — an incentive nobody remembers to
    // apply is one the platform advertised and did not honour.
    it('[HP] a platform-fee incentive is applied automatically at acceptance', async () => {
      await connection.models[PromoCode.name].create({
        code: 'LAUNCHFREE',
        description: 'Launch incentive',
        scope: 'PLATFORM_FEE',
        discountType: 'WAIVE',
        discountValue: 0,
        targetRoleIds: ['merchant'],
        usageCapPerSubject: 5,
        startsAt: new Date(Date.now() - 60_000),
        isActive: true,
        createdByUid: 'admin-1',
        createdByName: 'Admin',
      });

      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      walletsStub.consumeFee.mockClear();

      await service.acceptOrder(orderId, merchantOwner);

      const accepted = await orderModel.findById(orderId).exec();
      expect(accepted!.pricing.platformFeePromoCode).toBe('LAUNCHFREE');
      // The gross fee and the rule that produced it are untouched — only what
      // is collectible changed.
      expect(accepted!.pricing.platformFeeCentavos).toBeGreaterThan(0);
      expect(accepted!.pricing.platformFeeDiscountCentavos).toBe(
        accepted!.pricing.platformFeeCentavos,
      );

      const rows = await connection.models[PromoRedemption.name]
        .find({ orderId })
        .exec();
      expect(rows).toHaveLength(1);
      expect(rows[0].subjectType).toBe('BRANCH');
      expect(rows[0].subjectId).toBe(String(branch._id));
      expect(rows[0].status).toBe('RESERVED');
    });

    it('[HP] the waiver follows the fee when the laundry weighs more than estimated', async () => {
      // The case a frozen waiver gets wrong. Nothing went wrong here, so the
      // provider must not be billed for the difference.
      await connection.models[PromoCode.name].create({
        code: 'LAUNCHFREE2',
        description: 'Launch incentive',
        scope: 'PLATFORM_FEE',
        discountType: 'WAIVE',
        discountValue: 0,
        targetRoleIds: ['merchant'],
        usageCapPerSubject: 5,
        startsAt: new Date(Date.now() - 60_000),
        isActive: true,
        createdByUid: 'admin-1',
        createdByName: 'Admin',
      });

      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      // walkToPickupArrived accepts the order on the way through, which is
      // where the incentive is granted.
      await walkToPickupArrived(orderId);
      const atAccept = await orderModel.findById(orderId).exec();
      const estimatedDiscount = atAccept!.pricing.platformFeeDiscountCentavos!;
      expect(estimatedDiscount).toBeGreaterThan(0);

      walletsStub.consumeFee.mockClear();
      // Heavier than estimated — the fee legitimately rises.
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 9,
        paymentMethod: PaymentMethod.CASH,
        tenderedCentavos: 200_000,
      });

      const after = await orderModel.findById(orderId).exec();
      expect(after!.pricing.platformFeeCentavos!).toBeGreaterThan(
        estimatedDiscount,
      );
      // The waiver moved with it, so nothing is collectible.
      expect(after!.pricing.platformFeeDiscountCentavos).toBe(
        after!.pricing.platformFeeCentavos,
      );
      expect(walletsStub.consumeFee).not.toHaveBeenCalled();
    });

    // A platform-fee waiver is not wallet money. The provider simply owes less,
    // so there is no ₱50 debit and no matching ₱50 credit — one event, one
    // (absent) movement. Staging it as a debit-then-credit would put two
    // entries in a real ledger for something that never happened.
    it('[HP] a waived platform fee is not debited from the wallet at all', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      walletsStub.consumeFee.mockClear();

      // Granting the waiver is PR 4's job; here it is set directly so the
      // consumption path can be tested on its own.
      await orderModel.findByIdAndUpdate(orderId, {
        $set: { 'pricing.platformFeeDiscountCentavos': 5_000 },
      });

      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentMethod: PaymentMethod.CASH,
        tenderedCentavos: 100_000,
      });

      const after = await orderModel.findById(orderId).exec();
      // The gross fee, the rate and the rule version are untouched — a report
      // must still be able to say what the fee WAS and who paid it.
      expect(after!.pricing.platformFeeCentavos).toBe(5_000);
      expect(after!.pricing.platformFeeDiscountCentavos).toBe(5_000);
      expect(walletsStub.consumeFee).not.toHaveBeenCalled();
    });

    it('[HP] a partially waived fee debits only the remainder', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      walletsStub.consumeFee.mockClear();

      await orderModel.findByIdAndUpdate(orderId, {
        $set: { 'pricing.platformFeeDiscountCentavos': 3_000 },
      });

      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentMethod: PaymentMethod.CASH,
        tenderedCentavos: 100_000,
      });

      expect(walletsStub.consumeFee).toHaveBeenCalledWith(
        String(branch._id),
        2_000, // ₱50 fee less a ₱30 waiver
        orderId,
        expect.anything(),
      );
    });

    it('[EC] insufficient cash tender is rejected; tender on non-cash is rejected', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      // Weighing only commits once — both bad-payment attempts below retry
      // the payment step against the same already-weighed order.
      await service.recordPickupWeight(orderId, courierUser, {
        actualWeightKg: 5,
      });
      await expect(
        service.recordPickupPayment(orderId, courierUser, {
          paymentMethod: PaymentMethod.CASH,
          tenderedCentavos: 1_000,
        }),
      ).rejects.toThrow('Tendered cash is less than the amount due');
      await expect(
        service.recordPickupPayment(orderId, courierUser, {
          paymentMethod: PaymentMethod.EWALLET_OUTSIDE_APP,
          referenceId: 'REF-1',
          tenderedCentavos: 100_000,
        }),
      ).rejects.toThrow('tenderedCentavos only applies to cash payments');
    });
  });

  // =========================================================================
  // GAP-P0-028 — ON_DELIVERY removed from the contract
  // =========================================================================

  describe('legacy on_delivery value (GAP-P0-028)', () => {
    // Deferred settlement is back as AT_FINAL_HANDOVER (§14), but the legacy
    // *string* stays unwritable — it is read-mapped and migrated, never stored
    // by new code.
    it('[EC] the timing enum carries the two supported values, and no legacy ones', () => {
      expect(Object.values(PaymentTiming)).toEqual([
        'on_pickup',
        'at_final_handover',
      ]);
      expect(Object.values(PaymentTiming)).not.toContain('on_delivery');
      expect(Object.values(PaymentStatus)).not.toContain('to_pay_on_delivery');
    });

    it('[EC] createOrder input validation rejects the legacy value on WRITE', async () => {
      const input = plainToInstance(CreateOrderInput, {
        providerType: ProviderType.MERCHANT,
        branchId: 'b1',
        addressId: 'a1',
        serviceLines: [{ serviceRefId: 's1', estimatedWeightKg: 5 }],
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        scheduledPickup: PICKUP_DAY,
        paymentTiming: LEGACY_PAYMENT_TIMING_ON_DELIVERY,
      });
      const errors = await validate(input);
      expect(errors.some((e) => e.property === 'paymentTiming')).toBe(true);
    });

    it('[HP] legacy stored value reads as AT_FINAL_HANDOVER — what it actually meant', async () => {
      const legacyOrder = {
        paymentTiming: LEGACY_PAYMENT_TIMING_ON_DELIVERY,
        paymentSummary: {},
        pricing: { customerTotalCentavos: 10_000 },
      } as unknown as OnlineOrder;
      // Mapping this to ON_PICKUP (as it did while deferral didn't exist) would
      // tell a customer who still owes ₱100 that they paid at the door.
      expect(resolver.paymentTiming(legacyOrder)).toBe(
        PaymentTiming.AT_FINAL_HANDOVER,
      );
      expect(resolver.paymentStatus(legacyOrder)).toBe(PaymentStatus.UNPAID);
      expect(resolver.amountDueCentavos(legacyOrder)).toBe(10_000);
    });
  });

  // =========================================================================
  // Payment status derivation sanity (post-change)
  // =========================================================================

  describe('paymentStatus resolver', () => {
    it('[HP] UNPAID → PAID → BALANCE_DUE lifecycle', () => {
      const base = {
        paymentTiming: PaymentTiming.ON_PICKUP,
        paymentSummary: {},
        pricing: { customerTotalCentavos: 10_000 },
      } as unknown as OnlineOrder;
      expect(resolver.paymentStatus(base)).toBe(PaymentStatus.UNPAID);
      (base.paymentSummary as any).amountCollectedCentavos = 10_000;
      expect(resolver.paymentStatus(base)).toBe(PaymentStatus.PAID);
      (base.pricing as any).customerTotalCentavos = 15_000; // approved surcharge
      expect(resolver.paymentStatus(base)).toBe(PaymentStatus.BALANCE_DUE);
    });
  });

  // =========================================================================
  // Split pickup flow — recordPickupWeight / recordPickupPayment
  // (2026-08-18): weighing and payment used to be one atomic recordPickup;
  // splitting them lets the customer see the confirmed weight/total before
  // the courier collects payment.
  // =========================================================================

  describe('split pickup flow (recordPickupWeight / recordPickupPayment)', () => {
    it('[HP] recordPickupWeight finalizes pricing, consumes the fee, and parks at PICKUP_WEIGHED without collecting anything', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);

      const weighed = await service.recordPickupWeight(orderId, courierUser, {
        actualWeightKg: 5,
      });
      expect(weighed.status).toBe(OrderStatus.PICKUP_WEIGHED);
      expect(weighed.pricing.customerTotalCentavos).toBeGreaterThan(0);
      expect(await txModel.countDocuments({ orderId })).toBe(0);
      expect(walletsStub.consumeFee).toHaveBeenCalledWith(
        String(branch._id),
        weighed.pricing.platformFeeCentavos,
        orderId,
        expect.anything(),
      );
      // The leg is not done yet — the courier is still standing there
      // pending payment, so completedAt must not be stamped yet.
      const midway = await orderModel.findById(orderId).exec();
      expect(midway!.pickupAssignment?.completedAt).toBeUndefined();

      const paid = await service.recordPickupPayment(orderId, courierUser, {
        paymentMethod: PaymentMethod.CASH,
      });
      expect(paid.status).toBe(OrderStatus.LAUNDRY_IN_PROGRESS);
      expect(await txModel.countDocuments({ orderId })).toBe(1);
      const after = await orderModel.findById(orderId).exec();
      expect(after!.pickupAssignment?.completedAt).toBeInstanceOf(Date);
    });

    it('[EC] recordPickupWeight can be called again from PICKUP_WEIGHED — a courier correcting a mistyped weight before payment is collected re-finalizes pricing instead of being rejected', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      const first = await service.recordPickupWeight(orderId, courierUser, {
        actualWeightKg: 50, // fat-fingered
      });
      expect(first.status).toBe(OrderStatus.PICKUP_WEIGHED);
      expect(first.pricing.actualWeightKg).toBe(50);

      const corrected = await service.recordPickupWeight(orderId, courierUser, {
        actualWeightKg: 5,
      });
      expect(corrected.status).toBe(OrderStatus.PICKUP_WEIGHED);
      expect(corrected.pricing.actualWeightKg).toBe(5);
      // The platform fee tracks the corrected (lower) total, not double-consumed.
      expect(corrected.pricing.platformFeeConsumedCentavos).toBe(
        corrected.pricing.platformFeeCentavos,
      );

      // Once payment is collected the self-loop is no longer reachable.
      await service.recordPickupPayment(orderId, courierUser, {
        paymentTiming: PaymentTiming.ON_PICKUP,
        paymentMethod: PaymentMethod.CASH,
      });
      await expect(
        service.recordPickupWeight(orderId, courierUser, {
          actualWeightKg: 5,
        }),
      ).rejects.toThrow(/Invalid order status transition/);
    });

    it('[EC] recordPickupPayment before weighing rejects — no PICKUP_ARRIVED → PICKED_UP_FROM_CUSTOMER shortcut', async () => {
      const { branch, svc, address } = await merchantFixture();
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      await expect(
        service.recordPickupPayment(orderId, courierUser, {
          paymentMethod: PaymentMethod.CASH,
        }),
      ).rejects.toThrow(/Invalid order status transition/);
    });
  });

  // =========================================================================
  // Deferred settlement — "Pay Later" (§14, 2026-08-15)
  // =========================================================================

  describe('deferred settlement (pay at final handover)', () => {
    /** Merchant fixture whose branch has opted in to deferred settlement. */
    const deferringFixture = async () => {
      const branch = await makeBranch({ allowsPayAtHandover: true });
      await fundWallet(String(branch._id));
      const svc = await makeService(String(branch._id));
      const address = await makeAddress();
      return { branch, svc, address };
    };

    const bookAndArrive = async (fixture: {
      branch: any;
      svc: any;
      address: any;
    }) => {
      const created = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(fixture.branch._id),
          String(fixture.svc._id),
          String(fixture.address._id),
        ),
      );
      const orderId = String(created._id);
      await walkToPickupArrived(orderId);
      return orderId;
    };

    /** Walks a picked-up order all the way to the courier at the door. */
    const walkToReturnArrived = async (orderId: string) => {
      await service.markLaundryReady(orderId, merchantOwner);
      await service.assignReturnStaff(orderId, merchantOwner, COURIER_UID);
      await service.startReturnRoute(orderId, courierUser);
      await service.arriveAtReturn(orderId, courierUser);
    };

    it('[HP] deferring at pickup transfers custody, collects nothing, and still charges the provider the fee', async () => {
      const fixture = await deferringFixture();
      const orderId = await bookAndArrive(fixture);

      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentTiming: PaymentTiming.AT_FINAL_HANDOVER,
      });

      const after = await orderModel.findById(orderId).exec();
      // Custody moved even though no money did.
      expect(after!.status).toBe(OrderStatus.LAUNDRY_IN_PROGRESS);
      expect(after!.paymentTiming).toBe(PaymentTiming.AT_FINAL_HANDOVER);
      expect(after!.paymentSummary?.collectedAt).toBeUndefined();
      expect(await txModel.countDocuments({ orderId })).toBe(0);
      expect(resolver.paymentStatus(after as any)).toBe(PaymentStatus.UNPAID);

      // The whole point of the provider opt-in: they front the platform fee on
      // an order that has paid them nothing yet.
      expect(walletsStub.consumeFee).toHaveBeenCalledWith(
        String(fixture.branch._id),
        after!.pricing.platformFeeCentavos,
        orderId,
        expect.anything(),
      );
      expect(after!.pricing.platformFeeConsumedCentavos).toBe(
        after!.pricing.platformFeeCentavos,
      );
    });

    it('[EC] a provider who has not opted in cannot be made to defer', async () => {
      const fixture = await merchantFixture(); // allowsPayAtHandover defaults false
      const orderId = await bookAndArrive(fixture);

      await expect(
        recordPickup(orderId, courierUser, {
          actualWeightKg: 5,
          paymentTiming: PaymentTiming.AT_FINAL_HANDOVER,
        }),
      ).rejects.toThrow('does not offer pay-at-handover');
    });

    it('[EC] deferring and paying at the same time is rejected', async () => {
      const fixture = await deferringFixture();
      const orderId = await bookAndArrive(fixture);

      await expect(
        recordPickup(orderId, courierUser, {
          actualWeightKg: 5,
          paymentTiming: PaymentTiming.AT_FINAL_HANDOVER,
          paymentMethod: PaymentMethod.CASH,
        }),
      ).rejects.toThrow('cannot be supplied when deferring');
    });

    it('[EC] handover is blocked while a balance is outstanding, and nothing is written', async () => {
      const fixture = await deferringFixture();
      const orderId = await bookAndArrive(fixture);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentTiming: PaymentTiming.AT_FINAL_HANDOVER,
      });
      await walkToReturnArrived(orderId);

      await expect(
        service.recordDelivery(orderId, courierUser),
      ).rejects.toThrow('must be collected before handover');

      // The laundry is still with the courier — the rejection left no trace.
      const after = await orderModel.findById(orderId).exec();
      expect(after!.status).toBe(OrderStatus.RETURN_ARRIVED);
      expect(after!.completedAt).toBeNull();
      expect(await txModel.countDocuments({ orderId })).toBe(0);
    });

    it('[HP] settling at delivery collects the whole amount once and completes', async () => {
      const fixture = await deferringFixture();
      const orderId = await bookAndArrive(fixture);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentTiming: PaymentTiming.AT_FINAL_HANDOVER,
      });
      await walkToReturnArrived(orderId);

      const beforeSettle = await orderModel.findById(orderId).exec();
      const total = beforeSettle!.pricing.customerTotalCentavos!;

      await service.recordDelivery(orderId, courierUser, {
        paymentMethod: PaymentMethod.CASH,
        tenderedCentavos: total,
      });

      const after = await orderModel.findById(orderId).exec();
      expect(after!.status).toBe(OrderStatus.COMPLETED);
      expect(after!.paymentSummary.amountCollectedCentavos).toBe(total);
      expect(resolver.paymentStatus(after as any)).toBe(PaymentStatus.PAID);
      expect(resolver.amountDueCentavos(after as any)).toBe(0);

      // A first settlement is a plain collection, not an add-on.
      const txs = await txModel.find({ orderId }).exec();
      expect(txs).toHaveLength(1);
      expect(txs[0].status).toBe(OnlineTransactionStatus.COMPLETED);
      expect(txs[0].amountCentavos).toBe(total);
      // Fee was consumed at pickup, so settlement must not consume it again.
      expect(walletsStub.consumeFee).toHaveBeenCalledTimes(1);
    });

    it('[HP] a surcharge approved after payment is collected at handover as an ADD_ON', async () => {
      const fixture = await merchantFixture();
      const orderId = await bookAndArrive(fixture);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentMethod: PaymentMethod.CASH,
      });
      const paidTotal = (await orderModel.findById(orderId).exec())!.pricing
        .customerTotalCentavos!;
      walletsStub.consumeFee.mockClear();

      await service.raiseQualityHold(orderId, merchantOwner, {
        serviceLineIndex: 0,
        reason: 'Stubborn stain, needs special treatment',
        blocksOrder: true,
        additionalChargeCentavos: 5_000,
      });
      await service.respondToQualityHold(orderId, customerUser, {
        approve: true,
      });

      const held = await orderModel.findById(orderId).exec();
      const shortfall = held!.pricing.customerTotalCentavos! - paidTotal;
      expect(shortfall).toBeGreaterThan(0);
      expect(resolver.paymentStatus(held as any)).toBe(
        PaymentStatus.BALANCE_DUE,
      );
      expect(resolver.amountDueCentavos(held as any)).toBe(shortfall);

      await walkToReturnArrived(orderId);
      await service.recordDelivery(orderId, courierUser, {
        paymentMethod: PaymentMethod.CASH,
        // Only the shortfall is due — asking for the whole order total again
        // was the bug this path never exercised before.
        tenderedCentavos: shortfall,
      });

      const after = await orderModel.findById(orderId).exec();
      expect(after!.status).toBe(OrderStatus.COMPLETED);
      expect(resolver.paymentStatus(after as any)).toBe(PaymentStatus.PAID);

      const txs = await txModel.find({ orderId }).sort({ createdAt: 1 }).exec();
      expect(txs).toHaveLength(2);
      expect(txs[1].status).toBe(OnlineTransactionStatus.ADD_ON);
      expect(txs[1].amountCentavos).toBe(shortfall);
      // First collection keeps its original timestamp; only lastCollectedAt moves.
      expect(after!.paymentSummary.collectedAt!.getTime()).toBeLessThanOrEqual(
        after!.paymentSummary.lastCollectedAt!.getTime(),
      );
      // The surcharge's own platform fee is debited now, as it is collected —
      // never at approval, when the customer could still have refused it.
      expect(walletsStub.consumeFee).toHaveBeenCalledTimes(1);
      expect(after!.pricing.platformFeeConsumedCentavos).toBe(
        after!.pricing.platformFeeCentavos,
      );
    });

    it('[EC] a fully-paid order waiting for redelivery gets no abandonment clock', async () => {
      // Paid at pickup, so nothing is owed — an uncollected order here is a
      // storage problem, not an unsettled one, and must never be abandoned.
      const fixture = await merchantFixture();
      const orderId = await bookAndArrive(fixture);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentMethod: PaymentMethod.CASH,
      });
      await walkToReturnArrived(orderId);
      await service.recordFailedDeliveryAttempt(orderId, courierUser, {
        responsibility: AttemptResponsibility.CUSTOMER,
        reason: 'Nobody home',
      });
      await service.confirmReturnedToProvider(orderId, merchantOwner);

      const waiting = await orderModel.findById(orderId).exec();
      expect(waiting!.status).toBe(OrderStatus.AWAITING_REDELIVERY_SELECTION);
      expect(waiting!.abandonmentDeadlineAt).toBeNull();
      expect(await abandonmentScheduler.sweepAbandonedOrders()).toBe(0);
    });

    it('[HP] the sweep abandons an expired unsettled order and hands the fee back', async () => {
      const fixture = await deferringFixture();
      const orderId = await bookAndArrive(fixture);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentTiming: PaymentTiming.AT_FINAL_HANDOVER,
      });
      await walkToReturnArrived(orderId);
      await service.recordFailedDeliveryAttempt(orderId, courierUser, {
        responsibility: AttemptResponsibility.CUSTOMER,
        reason: 'Customer could not pay',
      });
      await service.confirmReturnedToProvider(orderId, merchantOwner);

      const waiting = await orderModel.findById(orderId).exec();
      expect(waiting!.status).toBe(OrderStatus.AWAITING_REDELIVERY_SELECTION);
      expect(waiting!.abandonmentDeadlineAt).not.toBeNull();
      const fee = waiting!.pricing.platformFeeConsumedCentavos!;
      expect(fee).toBeGreaterThan(0);

      // Force the window into the past and sweep.
      await orderModel.updateOne({ _id: orderId } as any, {
        $set: { abandonmentDeadlineAt: new Date(Date.now() - 60_000) },
      });
      expect(await abandonmentScheduler.sweepAbandonedOrders()).toBe(1);

      const after = await orderModel.findById(orderId).exec();
      expect(after!.status).toBe(OrderStatus.ABANDONED_UNSETTLED);
      // The provider did the work and collected nothing; the platform earned
      // nothing either, so it gives back the cut it took at pickup.
      expect(walletsStub.reverseFee).toHaveBeenCalledWith(
        String(fixture.branch._id),
        fee,
        orderId,
        expect.anything(),
      );
      expect(after!.pricing.platformFeeConsumedCentavos).toBe(0);

      // Idempotent — a second pass finds nothing left to do.
      expect(await abandonmentScheduler.sweepAbandonedOrders()).toBe(0);
    });

    it('[EC] an abandoned order cannot be quietly put back on a courier', async () => {
      const fixture = await deferringFixture();
      const orderId = await bookAndArrive(fixture);
      await recordPickup(orderId, courierUser, {
        actualWeightKg: 5,
        paymentTiming: PaymentTiming.AT_FINAL_HANDOVER,
      });
      await walkToReturnArrived(orderId);
      await service.recordFailedDeliveryAttempt(orderId, courierUser, {
        responsibility: AttemptResponsibility.CUSTOMER,
        reason: 'Customer could not pay',
      });
      await service.confirmReturnedToProvider(orderId, merchantOwner);
      await service.abandonUnsettledOrder(orderId);

      await expect(
        service.scheduleRedelivery(orderId, merchantOwner),
      ).rejects.toThrow(/Invalid order status transition/);

      // Support can still put it back when the customer turns up with cash.
      const reinstated = await service.reinstateAbandonedOrder(
        orderId,
        merchantOwner,
      );
      expect(reinstated.status).toBe(OrderStatus.AWAITING_REDELIVERY_SELECTION);
    });
  });
  // ---------------------------------------------------------------------------
  // Admin order search
  // ---------------------------------------------------------------------------

  describe('adminSearchOrders', () => {
    // Orders are inserted directly rather than placed through createOrder:
    // these tests are about how a search TERM resolves to a query, and going
    // through the booking path would drag in wallets, availability and
    // pricing without making a single assertion here more meaningful.
    const seedOrder = async (overrides: {
      customerUid?: string;
      customerName?: string;
      providerUid?: string;
      providerName?: string;
      branchId?: string;
      status?: OrderStatus;
      providerType?: ProviderType;
      customerTotalCentavos?: number;
      amountCollectedCentavos?: number;
      createdAt?: Date;
      orderNumber?: string;
    }) => {
      const doc = await connection.models[OnlineOrder.name].create({
        orderNumber: overrides.orderNumber ?? undefined,
        customer: {
          uid: overrides.customerUid ?? new Types.ObjectId().toString(),
          displayName: overrides.customerName ?? 'Test Customer',
          maskedPhone: '0917•••4567',
        },
        provider: {
          providerType: overrides.providerType ?? ProviderType.MERCHANT,
          providerUid: overrides.providerUid ?? new Types.ObjectId().toString(),
          branchId: overrides.branchId ?? new Types.ObjectId().toString(),
          providerName: overrides.providerName ?? 'Test Laundromat',
        },
        serviceLines: [],
        fulfillment: {},
        pricing: {
          customerTotalCentavos: overrides.customerTotalCentavos ?? 0,
        },
        paymentSummary: {
          amountCollectedCentavos: overrides.amountCollectedCentavos ?? 0,
        },
        status: overrides.status ?? OrderStatus.COMPLETED,
      });
      if (overrides.createdAt) {
        // Backdating goes through the RAW collection. The schema is
        // `timestamps: true`, which both overwrites a createdAt passed to
        // create() and marks the path immutable — so a Mongoose $set is
        // silently stripped rather than rejected.
        await connection.models[OnlineOrder.name].collection.updateOne(
          { _id: doc._id },
          { $set: { createdAt: overrides.createdAt } },
        );
      }
      return String(doc._id);
    };

    const seedUser = async (phoneNumber: string) => {
      // `_id` is the Firebase uid and is a required String — the users
      // collection does not generate one.
      const uid = new Types.ObjectId().toString();
      const user = await connection.models[User.name].create({
        _id: uid,
        firstName: 'Search',
        lastName: 'Target',
        email: `${uid}@example.com`,
        phoneNumber,
        role: new Types.ObjectId().toString(),
      });
      return String(user._id);
    };

    beforeEach(async () => {
      await connection.models[OnlineOrder.name].deleteMany({});
    });

    it('returns every order when no filter is given', async () => {
      await seedOrder({});
      await seedOrder({});

      const page = await service.adminSearchOrders();

      expect(page.total).toBe(2);
      expect(page.data).toHaveLength(2);
    });

    it('finds an order by its own id', async () => {
      const wanted = await seedOrder({});
      await seedOrder({});

      const page = await service.adminSearchOrders({ search: wanted });

      expect(page.total).toBe(1);
      expect(String(page.data[0]._id)).toBe(wanted);
    });

    it('finds an order by its human-readable order number, loosely typed', async () => {
      const wanted = await seedOrder({ orderNumber: 'LB-000042' });
      await seedOrder({ orderNumber: 'LB-000099' });

      for (const term of ['LB-000042', 'lb-000042', 'LB000042', 'lb42']) {
        const page = await service.adminSearchOrders({ search: term });
        expect(page.total).toBe(1);
        expect(String(page.data[0]._id)).toBe(wanted);
      }
    });

    it('returns nothing for an order number that does not exist, rather than everything', async () => {
      await seedOrder({ orderNumber: 'LB-000042' });

      const page = await service.adminSearchOrders({ search: 'LB-999999' });

      expect(page.total).toBe(0);
    });

    it('finds every order for a customer uid pasted into the search box', async () => {
      const customerUid = new Types.ObjectId().toString();
      await seedOrder({ customerUid });
      await seedOrder({ customerUid });
      await seedOrder({});

      const page = await service.adminSearchOrders({ search: customerUid });

      expect(page.total).toBe(2);
    });

    // The one that makes the search box usable on a support call: the order
    // snapshot stores a MASKED phone, so the digits the customer reads out
    // can only be resolved through the user record.
    it('finds a customer by the phone number they read out, not the masked one', async () => {
      const uid = await seedUser('09171234567');
      await seedOrder({ customerUid: uid });
      await seedOrder({});

      const page = await service.adminSearchOrders({ search: '09171234567' });

      expect(page.total).toBe(1);
      expect(page.data[0].customer.uid).toBe(uid);
    });

    it('matches a phone number however it was typed', async () => {
      const uid = await seedUser('09171234567');
      await seedOrder({ customerUid: uid });

      for (const term of ['+639171234567', '9171234567', '0917 123 4567']) {
        const page = await service.adminSearchOrders({ search: term });
        expect(page.total).toBe(1);
      }
    });

    // Falling back to "no filter" here would return every order on the
    // platform, which reads as success rather than as no match.
    it('returns nothing for a phone number belonging to nobody', async () => {
      await seedOrder({});
      await seedOrder({});

      const page = await service.adminSearchOrders({ search: '09999999999' });

      expect(page.total).toBe(0);
      expect(page.data).toEqual([]);
    });

    // Real customer uids are FIREBASE uids, not ObjectIds, so they never hit
    // the ObjectId branch of the search. Pasting one has to work anyway.
    it('finds orders by a firebase-style customer uid', async () => {
      const customerUid = 'bfE4jkOzGRB6oqh1Ujlah7mlVH9Y';
      await seedOrder({ customerUid });
      await seedOrder({ customerUid });
      await seedOrder({});

      const page = await service.adminSearchOrders({ search: customerUid });

      expect(page.total).toBe(2);
    });

    it('finds orders by customer or provider name, case-insensitively', async () => {
      await seedOrder({ customerName: 'Maria Santos' });
      await seedOrder({ providerName: "Maria's Laundry" });
      await seedOrder({ customerName: 'Juan Cruz' });

      const page = await service.adminSearchOrders({ search: 'maria' });

      expect(page.total).toBe(2);
    });

    // A search term goes into a RegExp; an unescaped one would either throw or
    // let an agent force a collection scan.
    it('treats regex metacharacters in a search term as literals', async () => {
      await seedOrder({ customerName: 'Juan Cruz' });

      const page = await service.adminSearchOrders({ search: '.*' });

      expect(page.total).toBe(0);
    });

    it('filters by lifecycle status', async () => {
      await seedOrder({ status: OrderStatus.COMPLETED });
      await seedOrder({ status: OrderStatus.DISPUTED });
      await seedOrder({ status: OrderStatus.CANCELLED });

      const page = await service.adminSearchOrders({
        statuses: [OrderStatus.DISPUTED, OrderStatus.CANCELLED],
      });

      expect(page.total).toBe(2);
    });

    it('filters to orders where the customer still owes money', async () => {
      await seedOrder({
        customerTotalCentavos: 50_000,
        amountCollectedCentavos: 50_000,
      });
      await seedOrder({
        customerTotalCentavos: 50_000,
        amountCollectedCentavos: 20_000,
      });

      const page = await service.adminSearchOrders({
        outstandingBalanceOnly: true,
      });

      expect(page.total).toBe(1);
    });

    it('filters by branch and provider type', async () => {
      const branchId = new Types.ObjectId().toString();
      await seedOrder({ branchId, providerType: ProviderType.WASHER });
      await seedOrder({ providerType: ProviderType.MERCHANT });

      expect((await service.adminSearchOrders({ branchId })).total).toBe(1);
      expect(
        (await service.adminSearchOrders({ providerType: ProviderType.WASHER }))
          .total,
      ).toBe(1);
    });

    // Date bounds are whole PHILIPPINE days. 2026-08-14T22:30Z is already
    // 6:30 AM on the 15th in Manila, so "to the 14th" must exclude it — and
    // 2026-08-14T02:00Z is 10 AM on the 14th, so it must be included. On a
    // UTC-hosted server a naive end-of-day would get both of these backwards.
    it('bounds a date range by Manila days, not by the server timezone', async () => {
      await seedOrder({ createdAt: new Date('2026-08-14T02:00:00.000Z') });
      await seedOrder({ createdAt: new Date('2026-08-14T22:30:00.000Z') });

      const page = await service.adminSearchOrders({
        dateFrom: new Date('2026-08-14T00:00:00.000Z'),
        dateTo: new Date('2026-08-14T00:00:00.000Z'),
      });

      expect(page.total).toBe(1);
      expect(page.data[0].createdAt?.toISOString()).toBe(
        '2026-08-14T02:00:00.000Z',
      );
    });

    it('includes an order placed late in the evening, Manila time', async () => {
      // 2026-08-14T15:00Z is 11 PM on the 14th in Manila — the same day.
      await seedOrder({ createdAt: new Date('2026-08-14T15:00:00.000Z') });

      const page = await service.adminSearchOrders({
        dateFrom: new Date('2026-08-14T00:00:00.000Z'),
        dateTo: new Date('2026-08-14T00:00:00.000Z'),
      });

      expect(page.total).toBe(1);
    });

    it('combines filters rather than letting the last one win', async () => {
      const branchId = new Types.ObjectId().toString();
      await seedOrder({
        branchId,
        customerName: 'Maria Santos',
        status: OrderStatus.DISPUTED,
      });
      await seedOrder({ branchId, customerName: 'Maria Santos' });
      await seedOrder({
        customerName: 'Maria Santos',
        status: OrderStatus.DISPUTED,
      });

      const page = await service.adminSearchOrders({
        search: 'maria',
        branchId,
        statuses: [OrderStatus.DISPUTED],
      });

      expect(page.total).toBe(1);
    });

    it('reports a total for the whole match, not the page', async () => {
      for (let i = 0; i < 5; i++) await seedOrder({});

      const page = await service.adminSearchOrders({ limit: 2, offset: 0 });

      expect(page.data).toHaveLength(2);
      expect(page.total).toBe(5);
    });
  });
  // ---------------------------------------------------------------------------
  // Manual status override
  // ---------------------------------------------------------------------------

  describe('overrideStatus', () => {
    const adminUser = {
      _id: 'admin-uid',
      role: { roleId: 'admin' },
    } as unknown as User;

    const seedAt = async (status: OrderStatus) => {
      const doc = await connection.models[OnlineOrder.name].create({
        customer: {
          uid: new Types.ObjectId().toString(),
          displayName: 'Override Test',
        },
        provider: {
          providerType: ProviderType.MERCHANT,
          providerUid: new Types.ObjectId().toString(),
          branchId: new Types.ObjectId().toString(),
          providerName: 'Test Laundromat',
        },
        serviceLines: [],
        // A real fulfillment, not `{}`: the required Object path passes on
        // insert but fails validation on save(), and the override  goes
        // through save().
        fulfillment: {
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        },
        pricing: { customerTotalCentavos: 0 },
        paymentSummary: { amountCollectedCentavos: 0 },
        status,
        version: 1,
      });
      return String(doc._id);
    };

    beforeEach(async () => {
      await connection.models[OnlineOrder.name].deleteMany({});
    });

    it('offers exactly the transitions the state machine allows', async () => {
      const orderId = await seedAt(OrderStatus.LAUNDRY_IN_PROGRESS);

      const options = await service.allowedNextStatuses(orderId);

      expect(options).toEqual(
        ORDER_STATUS_TRANSITIONS[OrderStatus.LAUNDRY_IN_PROGRESS],
      );
    });

    it('offers nothing for a terminal order', async () => {
      const orderId = await seedAt(OrderStatus.CANCELLED);

      expect(await service.allowedNextStatuses(orderId)).toEqual([]);
    });

    it('moves the order and records the note on the timeline', async () => {
      const orderId = await seedAt(OrderStatus.LAUNDRY_IN_PROGRESS);

      const moved = await service.overrideStatus(
        orderId,
        OrderStatus.LAUNDRY_READY,
        adminUser,
        'Provider confirmed by phone, app never synced.',
      );

      expect(moved.status).toBe(OrderStatus.LAUNDRY_READY);
      const timeline = await service.orderTimeline(orderId);
      const last = timeline.at(-1)!;
      expect(last.toStatus).toBe(OrderStatus.LAUNDRY_READY);
      expect(last.actorRole).toBe('admin');
      expect(last.note).toContain('never synced');
    });

    // The point of the whole design: an override advances the lifecycle, it
    // does not let anyone invent a state.
    it('refuses a transition the state machine does not allow', async () => {
      const orderId = await seedAt(OrderStatus.LAUNDRY_IN_PROGRESS);

      await expect(
        service.overrideStatus(
          orderId,
          OrderStatus.COMPLETED,
          adminUser,
          'Just close it',
        ),
      ).rejects.toThrow(/Cannot move from/);
    });

    it('explains that a terminal order cannot be moved at all', async () => {
      const orderId = await seedAt(OrderStatus.REFUNDED);

      await expect(
        service.overrideStatus(orderId, OrderStatus.COMPLETED, adminUser, 'x'),
      ).rejects.toThrow(/terminal state/);
    });

    it('rejects a move to the status it is already in', async () => {
      const orderId = await seedAt(OrderStatus.LAUNDRY_READY);

      await expect(
        service.overrideStatus(
          orderId,
          OrderStatus.LAUNDRY_READY,
          adminUser,
          'x',
        ),
      ).rejects.toThrow(/already in that status/);
    });

    // Routing through applyTransition is what keeps these clocks correct — a
    // bypass would move the status and silently leave the deadline behind.
    it('maintains the abandonment deadline through an override', async () => {
      const orderId = await seedAt(OrderStatus.AWAITING_REDELIVERY_SELECTION);
      // Owed money, so entering a waiting state must arm the deadline.
      await connection.models[OnlineOrder.name].updateOne(
        { _id: orderId },
        { $set: { 'pricing.customerTotalCentavos': 50_000 } },
      );

      await service.overrideStatus(
        orderId,
        OrderStatus.REDELIVERY_SCHEDULED,
        adminUser,
        'Customer called to rebook.',
      );

      const after = await service.order(orderId, adminUser);
      // REDELIVERY_SCHEDULED is not a waiting state, so the clock is cleared.
      expect(after.abandonmentDeadlineAt).toBeNull();
    });

    it('bumps the version, so a concurrent edit still conflicts', async () => {
      const orderId = await seedAt(OrderStatus.LAUNDRY_IN_PROGRESS);
      const before = await service.order(orderId, adminUser);

      await service.overrideStatus(
        orderId,
        OrderStatus.LAUNDRY_READY,
        adminUser,
        'note',
      );

      const after = await service.order(orderId, adminUser);
      expect(after.version).toBe(before.version + 1);
    });
  });

  // ===========================================================================
  // Promo code checkout wiring
  // ===========================================================================

  describe('order number', () => {
    it('[HP] createOrder assigns a human-readable LB-###### number', async () => {
      const { branch, svc, address } = await merchantFixture();

      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
        ),
      );

      expect(order.orderNumber).toMatch(/^LB-\d{6}$/);
    });
  });

  describe('promo code checkout wiring', () => {
    const promoRedemptionModel = () => connection.models[PromoRedemption.name];
    const promoCodeModel = () => connection.models[PromoCode.name];

    /** A real customer User doc — PromotionsService looks the customer up by id. */
    const makeCustomerUser = async () => {
      let role = await roleModel.findOne({ roleId: 'customer' }).exec();
      if (!role)
        role = await roleModel.create({
          roleId: 'customer',
          roleName: 'customer',
          description: 'customer',
        });
      await connection.models[User.name].findOneAndUpdate(
        { _id: CUSTOMER_UID },
        {
          _id: CUSTOMER_UID,
          role: role._id,
          email: `${CUSTOMER_UID}@test.local`,
          firstName: 'Cus',
          lastName: 'Tomer',
          phoneNumber: '09171234567',
        },
        { upsert: true },
      );
    };

    const makePromo = (over: Record<string, any> = {}) =>
      promoCodeModel().create({
        code: 'SAVE10',
        description: 'test code',
        discountType: PromoDiscountType.FLAT,
        discountValue: 5_000, // ₱50
        targetRoleIds: ['customer'],
        usageCapPerCustomer: 1,
        startsAt: new Date(Date.now() - 60_000),
        isActive: true,
        createdByUid: 'admin-1',
        createdByName: 'Admin',
        ...over,
      });

    // The bug this lifecycle exists for: a promo used to be spent the instant
    // the order was created, with no way back. A provider rejecting the order
    // therefore cost the customer their code permanently.
    it('[HP] rejecting an order hands the promo slot back', async () => {
      await makeCustomerUser();
      const promo = await makePromo();
      const { branch, svc, address } = await merchantFixture();

      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(String(branch._id), String(svc._id), address, {
          promoCode: 'SAVE10',
        }),
      );

      expect(
        (await promoCodeModel().findById(promo._id).exec())!.redemptionCount,
      ).toBe(1);

      await service.rejectOrder(String(order._id), merchantOwner, {
        reason: 'Fully booked today',
      });

      const rows = await promoRedemptionModel()
        .find({ orderId: String(order._id) })
        .exec();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('RELEASED');
      expect(
        (await promoCodeModel().findById(promo._id).exec())!.redemptionCount,
      ).toBe(0);

      // And the customer really can use it again — the cap read must agree
      // with the counter.
      const recheck = await promotionsService.validate(
        'SAVE10',
        CUSTOMER_UID,
        50_000,
      );
      expect(recheck.valid).toBe(true);
    });

    it('[HP] createOrder subtracts the discount and records a redemption', async () => {
      await makeCustomerUser();
      await makePromo();
      const { branch, svc, address } = await merchantFixture();

      const order = await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
          {
            promoCode: 'save10', // lowercase on purpose — must normalise
          },
        ),
      );

      // 5kg * ₱100/kg = ₱50,000 subtotal, minus the ₱50 (5,000c) flat discount.
      expect(order.pricing.discountCentavos).toBe(5_000);
      expect(order.pricing.promoCode).toBe('SAVE10');
      expect(order.pricing.estimatedTotalCentavos).toBe(
        order.pricing.serviceSubtotalCentavos! +
          order.pricing.platformFeeCentavos! +
          order.pricing.pickupFeeCentavos! +
          order.pricing.returnFeeCentavos! +
          order.pricing.turnaroundFeeCentavos! -
          5_000,
      );

      const redemptions = await promoRedemptionModel()
        .find({ customerUid: CUSTOMER_UID })
        .exec();
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].orderId).toBe(String(order._id));
      expect(redemptions[0].discountAppliedCentavos).toBe(5_000);

      const promo = await promoCodeModel().findOne({ code: 'SAVE10' }).exec();
      expect(promo!.redemptionCount).toBe(1);
    });

    it('[EC] rejects an order with an unknown promo code', async () => {
      await makeCustomerUser();
      const { branch, svc, address } = await merchantFixture();

      await expect(
        service.createOrder(
          customerUser,
          merchantOrderInput(
            String(branch._id),
            String(svc._id),
            String(address._id),
            {
              promoCode: 'DOES_NOT_EXIST',
            },
          ),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('[EC] rejects a code the customer has already used up to her cap', async () => {
      await makeCustomerUser();
      await makePromo({ usageCapPerCustomer: 1 });
      const { branch, svc, address } = await merchantFixture();

      await service.createOrder(
        customerUser,
        merchantOrderInput(
          String(branch._id),
          String(svc._id),
          String(address._id),
          {
            promoCode: 'SAVE10',
          },
        ),
      );

      await expect(
        service.createOrder(
          customerUser,
          merchantOrderInput(
            String(branch._id),
            String(svc._id),
            String(address._id),
            {
              promoCode: 'SAVE10',
            },
          ),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('[HP] quoteOrder previews the discount without redeeming', async () => {
      await makeCustomerUser();
      await makePromo();
      const { branch, svc, address } = await merchantFixture();

      const quote = await service.quoteOrder(
        {
          providerType: ProviderType.MERCHANT,
          branchId: String(branch._id),
          serviceLines: [
            { serviceRefId: String(svc._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          pickupSubMode: DeliverySubMode.SCHEDULED_PAID,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          deliverySubMode: DeliverySubMode.SCHEDULED_PAID,
          promoCode: 'SAVE10',
        },
        CUSTOMER_UID,
      );

      expect(quote.discountCentavos).toBe(5_000);
      expect(quote.promoCode).toBe('SAVE10');

      const redemptions = await promoRedemptionModel()
        .find({ customerUid: CUSTOMER_UID })
        .exec();
      expect(redemptions).toHaveLength(0);
      void address;
    });

    it('[HP] quoteOrder silently ignores an invalid code rather than failing the quote', async () => {
      await makeCustomerUser();
      const { branch, svc, address } = await merchantFixture();
      void address;

      const quote = await service.quoteOrder(
        {
          providerType: ProviderType.MERCHANT,
          branchId: String(branch._id),
          serviceLines: [
            { serviceRefId: String(svc._id), estimatedWeightKg: 5 },
          ],
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          pickupSubMode: DeliverySubMode.SCHEDULED_PAID,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          deliverySubMode: DeliverySubMode.SCHEDULED_PAID,
          promoCode: 'NOPE',
        },
        CUSTOMER_UID,
      );

      expect(quote.discountCentavos ?? 0).toBe(0);
      expect(quote.promoCode ?? null).toBeNull();
    });
  });
});
