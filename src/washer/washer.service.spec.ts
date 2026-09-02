// Jest mock assertions like expect(mock.fn) trip @typescript-eslint/unbound-method
// on plain mocked-interface references — safe here, so disabled for this spec.
/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { WasherService } from './washer.service';
import {
  WasherProfile,
  WasherProfileSchema,
} from './schemas/washer-profile.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import { Rating, RatingSchema } from '../ratings/schemas/rating.schema';
import { OrderStatus } from '../online-orders/schemas/order-status.enum';
import { WasherServiceTemplatesService } from '../washer-service-templates/washer-service-templates.service';
import { UpdateWasherProfileInput } from './dto/update-washer-profile.input';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';
import { User } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { BookingPolicyService } from '../booking-policy/booking-policy.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WASHER_UID = 'washer-uid-001';
const OTHER_UID = 'washer-uid-999';

const PH_OFFSET_MS = 8 * 3600 * 1000;
function startOfTodayPH(): Date {
  const nowInPH = new Date(Date.now() + PH_OFFSET_MS);
  return new Date(
    Date.UTC(
      nowInPH.getUTCFullYear(),
      nowInPH.getUTCMonth(),
      nowInPH.getUTCDate(),
    ) - PH_OFFSET_MS,
  );
}

// Raw online_orders documents — inserted directly into the collection so we
// can control createdAt/completedAt and only carry the fields the stats
// aggregation reads (provider, status, pricing, serviceLines, timestamps).
const makeOrderDoc = (overrides: Record<string, any> = {}) => ({
  customer: { uid: 'customer-1', displayName: 'Cust' },
  provider: {
    providerType: 'washer',
    providerUid: WASHER_UID,
    branchId: 'branch-1',
  },
  serviceLines: [{ serviceRefId: 's1', serviceName: 'Wash & Dry' }],
  pricing: { estimatedWeightKg: 5 },
  status: OrderStatus.COMPLETED,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeDaySchedule = () => ({
  isOpen: true,
  is24Hours: false,
  timeSlots: [{ open: '08:00', close: '20:00' }],
});

const makeOperatingHours = (overrides: Record<string, any> = {}) => ({
  monday: makeDaySchedule(),
  tuesday: makeDaySchedule(),
  wednesday: makeDaySchedule(),
  thursday: makeDaySchedule(),
  friday: makeDaySchedule(),
  saturday: makeDaySchedule(),
  sunday: { isOpen: false, is24Hours: false, timeSlots: [] },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('WasherService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: WasherService;
  let module: TestingModule;
  const filterValidActiveIds = jest.fn();
  const storageMock: jest.Mocked<StorageProvider> = {
    upload: jest.fn(async (_b, key, _ct) => `https://public.example/${key}`),
    uploadPrivate: jest.fn(async (_b, key, _ct) => key),
    getSignedReadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
    delete: jest.fn(async (_key: string): Promise<void> => {}),
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
          { name: Rating.name, schema: RatingSchema },
        ]),
      ],
      providers: [
        WasherService,
        {
          provide: WasherServiceTemplatesService,
          useValue: { filterValidActiveIds },
        },
        { provide: STORAGE_PROVIDER, useValue: storageMock },
        {
          provide: UsersService,
          useValue: { setWasherStatus: jest.fn(async () => {}) },
        },
        {
          provide: BookingPolicyService,
          useValue: {
            current: jest.fn(async () => ({
              safetyLimits: { maxServiceRadiusKm: 15 },
            })),
          },
        },
      ],
    }).compile();

    service = module.get<WasherService>(WasherService);
    mongoConnection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await module.close();
    await mongod.stop();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    const collections = mongoConnection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  const seedProfile = async (overrides: Record<string, any> = {}) => {
    await mongoConnection.collection('washer_profiles').insertOne({
      uid: WASHER_UID,
      displayName: 'Aling Nena',
      branchId: 'branch-1',
      offeredServiceTemplateIds: [],
      isAvailable: false,
      ...overrides,
    });
  };

  const seedOrders = async (docs: Record<string, any>[]) => {
    await mongoConnection.collection('online_orders').insertMany(docs);
  };

  // -------------------------------------------------------------------------
  // getStats — canonical online_orders-derived stats (GAP-P0-011)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // getReport — the Reports screen's windowed summary
  // -------------------------------------------------------------------------

  describe('getReport', () => {
    const day = (offsetDays: number) => {
      const d = new Date(Date.now() + offsetDays * 86400000 + PH_OFFSET_MS);
      return d.toISOString().slice(0, 10);
    };
    const at = (dateStr: string) => new Date(`${dateStr}T04:00:00+08:00`);

    const seedRatings = async (docs: Record<string, any>[]) => {
      await mongoConnection.collection('ratings').insertMany(docs);
    };

    it('[HP] sums completed orders, money and weight inside the window', async () => {
      await seedProfile();
      const today = day(0);
      await seedOrders([
        makeOrderDoc({
          completedAt: at(today),
          pricing: {
            customerTotalCentavos: 50000,
            platformFeeCentavos: 5000,
            actualWeightKg: 6,
          },
        }),
        makeOrderDoc({
          completedAt: at(today),
          pricing: {
            customerTotalCentavos: 30000,
            platformFeeCentavos: 3000,
            actualWeightKg: 4,
          },
        }),
      ]);

      const r = await service.getReport(WASHER_UID, today, today);

      expect(r.ordersCompleted).toBe(2);
      expect(r.grossCentavos).toBe(80000);
      expect(r.platformFeeCentavos).toBe(8000);
      // Precomputed so the app never re-derives money and can't disagree.
      expect(r.netCentavos).toBe(72000);
      expect(r.totalKg).toBe(10);
    });

    it('[HP] dateTo is INCLUSIVE — a single-day report is not empty', async () => {
      // The upper bound is exclusive internally; getting this wrong makes every
      // same-day report silently return zero.
      await seedProfile();
      const today = day(0);
      await seedOrders([
        makeOrderDoc({
          completedAt: at(today),
          pricing: { customerTotalCentavos: 10000, platformFeeCentavos: 1000 },
        }),
      ]);

      const r = await service.getReport(WASHER_UID, today, today);
      expect(r.ordersCompleted).toBe(1);
    });

    it('[EC] excludes orders completed outside the window', async () => {
      await seedProfile();
      await seedOrders([
        makeOrderDoc({
          completedAt: at(day(-10)),
          pricing: { customerTotalCentavos: 99999, platformFeeCentavos: 9999 },
        }),
      ]);

      const r = await service.getReport(WASHER_UID, day(-1), day(0));
      expect(r.ordersCompleted).toBe(0);
      expect(r.grossCentavos).toBe(0);
      expect(r.netCentavos).toBe(0);
    });

    it('[EC] windows on completedAt, not createdAt', async () => {
      // An order booked last month and delivered today belongs to today.
      await seedProfile();
      const today = day(0);
      await seedOrders([
        makeOrderDoc({
          createdAt: at(day(-30)),
          completedAt: at(today),
          pricing: { customerTotalCentavos: 20000, platformFeeCentavos: 2000 },
        }),
      ]);

      const r = await service.getReport(WASHER_UID, today, today);
      expect(r.ordersCompleted).toBe(1);
    });

    it('[EC] falls back to the estimate when no final total was recorded', async () => {
      await seedProfile();
      const today = day(0);
      await seedOrders([
        makeOrderDoc({
          completedAt: at(today),
          pricing: { estimatedTotalCentavos: 12345, platformFeeCentavos: 0 },
        }),
      ]);

      const r = await service.getReport(WASHER_UID, today, today);
      expect(r.grossCentavos).toBe(12345);
    });

    it('[HP] counts cancellations and rejections separately', async () => {
      await seedProfile();
      const today = day(0);
      await seedOrders([
        makeOrderDoc({ status: OrderStatus.CANCELLED, updatedAt: at(today) }),
        makeOrderDoc({
          status: OrderStatus.REJECTED_BY_PROVIDER,
          updatedAt: at(today),
        }),
        makeOrderDoc({
          completedAt: at(today),
          pricing: { customerTotalCentavos: 100, platformFeeCentavos: 0 },
        }),
      ]);

      const r = await service.getReport(WASHER_UID, today, today);
      expect(r.ordersCancelled).toBe(2);
      expect(r.ordersCompleted).toBe(1);
    });

    it("[EC] another washer's orders never appear", async () => {
      await seedProfile();
      const today = day(0);
      await seedOrders([
        makeOrderDoc({
          provider: {
            providerType: 'washer',
            providerUid: OTHER_UID,
            branchId: 'branch-9',
          },
          completedAt: at(today),
          pricing: { customerTotalCentavos: 99999, platformFeeCentavos: 9999 },
        }),
      ]);

      const r = await service.getReport(WASHER_UID, today, today);
      expect(r.ordersCompleted).toBe(0);
    });

    it('[EC] avgRating is null when nothing was rated, not zero', async () => {
      // 0 would render as "rated one star" — a materially different claim.
      await seedProfile();
      const today = day(0);
      const r = await service.getReport(WASHER_UID, today, today);
      expect(r.avgRating).toBeNull();
      expect(r.reviewCount).toBe(0);
    });

    it('[HP] averages ratings left in the window', async () => {
      await seedProfile();
      const today = day(0);
      // orderId is uniquely indexed — each rating needs its own.
      await seedRatings([
        {
          orderId: 'o1',
          branchId: 'branch-1',
          overallScore: 5,
          createdAt: at(today),
        },
        {
          orderId: 'o2',
          branchId: 'branch-1',
          overallScore: 3,
          createdAt: at(today),
        },
        // Outside the window, and another branch — neither counts.
        {
          orderId: 'o3',
          branchId: 'branch-1',
          overallScore: 1,
          createdAt: at(day(-30)),
        },
        {
          orderId: 'o4',
          branchId: 'branch-9',
          overallScore: 1,
          createdAt: at(today),
        },
      ]);

      const r = await service.getReport(WASHER_UID, today, today);
      expect(r.reviewCount).toBe(2);
      expect(r.avgRating).toBe(4);
    });

    it('[EC] rejects an end date before the start date', async () => {
      await seedProfile();
      await expect(
        service.getReport(WASHER_UID, day(0), day(-5)),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getStats', () => {
    it('[HP] computes lifetime completed overview (count, kg, loads) from online_orders', async () => {
      await seedProfile();
      await seedOrders([
        makeOrderDoc({
          pricing: { estimatedWeightKg: 5, actualWeightKg: 6.5 },
          serviceLines: [{ serviceRefId: 'a' }, { serviceRefId: 'b' }],
        }),
        makeOrderDoc({ pricing: { estimatedWeightKg: 4 } }), // falls back to estimate
        makeOrderDoc({ status: OrderStatus.LAUNDRY_IN_PROGRESS }), // not completed — excluded
      ]);

      const stats = await service.getStats(WASHER_UID);

      expect(stats.completedOrders).toBe(2);
      expect(stats.totalKg).toBe(10.5); // 6.5 actual + 4 estimated
      expect(stats.totalLoads).toBe(3); // 2 lines + 1 line
    });

    it('[HP] counts activeOrders as accepted, in-flight, non-terminal orders only', async () => {
      await seedProfile();
      await seedOrders([
        makeOrderDoc({ status: OrderStatus.ACCEPTED_BY_PROVIDER }),
        makeOrderDoc({ status: OrderStatus.LAUNDRY_IN_PROGRESS }),
        makeOrderDoc({ status: OrderStatus.RETURN_EN_ROUTE }),
        // none of these are active:
        makeOrderDoc({ status: OrderStatus.PENDING_PROVIDER_ACCEPTANCE }),
        makeOrderDoc({ status: OrderStatus.COMPLETED }),
        makeOrderDoc({ status: OrderStatus.CANCELLED }),
        makeOrderDoc({ status: OrderStatus.REJECTED_BY_PROVIDER }),
        makeOrderDoc({ status: OrderStatus.REFUNDED }),
        makeOrderDoc({ status: OrderStatus.DISPUTED }),
        makeOrderDoc({ status: OrderStatus.DRAFT }),
      ]);

      const stats = await service.getStats(WASHER_UID);
      expect(stats.activeOrders).toBe(3);
    });

    it('[HP] slotsUsedToday matches the daily-cap semantics (today PH, accepted-or-beyond only)', async () => {
      await seedProfile();
      const yesterday = new Date(startOfTodayPH().getTime() - 3600 * 1000);
      await seedOrders([
        makeOrderDoc({ status: OrderStatus.PENDING_PROVIDER_ACCEPTANCE }), // excluded — not yet accepted
        makeOrderDoc({ status: OrderStatus.LAUNDRY_IN_PROGRESS }),
        makeOrderDoc({ status: OrderStatus.COMPLETED }),
        makeOrderDoc({ status: OrderStatus.CANCELLED }), // excluded
        makeOrderDoc({ status: OrderStatus.REJECTED_BY_PROVIDER }), // excluded
        makeOrderDoc({ createdAt: yesterday }), // excluded — before today PH
      ]);

      const stats = await service.getStats(WASHER_UID);
      expect(stats.slotsUsedToday).toBe(2);
    });

    it('[HP] completedOrdersToday counts only orders completed today (PH time)', async () => {
      await seedProfile();
      const yesterday = new Date(startOfTodayPH().getTime() - 3600 * 1000);
      await seedOrders([
        makeOrderDoc({ completedAt: new Date(), createdAt: yesterday }),
        makeOrderDoc({ completedAt: yesterday, createdAt: yesterday }),
        makeOrderDoc({ status: OrderStatus.LAUNDRY_READY }), // not completed
      ]);

      const stats = await service.getStats(WASHER_UID);
      expect(stats.completedOrdersToday).toBe(1);
      expect(stats.completedOrders).toBe(2);
    });

    it('[HP] ignores orders belonging to other washers', async () => {
      await seedProfile();
      await seedOrders([
        makeOrderDoc(),
        makeOrderDoc({
          provider: {
            providerType: 'washer',
            providerUid: OTHER_UID,
            branchId: 'branch-9',
          },
          status: OrderStatus.LAUNDRY_IN_PROGRESS,
        }),
        makeOrderDoc({
          provider: {
            providerType: 'washer',
            providerUid: OTHER_UID,
            branchId: 'branch-9',
          },
        }),
      ]);

      const stats = await service.getStats(WASHER_UID);
      expect(stats.completedOrders).toBe(1);
      expect(stats.activeOrders).toBe(0);
      expect(stats.slotsUsedToday).toBe(1);
    });

    it('[HP] surfaces rating from the profile ratingAggregate and zeroes when unrated', async () => {
      await seedProfile({
        ratingAggregate: { count: 12, overallAverage: 4.6 },
      });
      const rated = await service.getStats(WASHER_UID);
      expect(rated.avgRating).toBe(4.6);
      expect(rated.totalReviews).toBe(12);

      await mongoConnection.collection('washer_profiles').deleteMany({});
      await seedProfile();
      const unrated = await service.getStats(WASHER_UID);
      expect(unrated.avgRating).toBeUndefined();
      expect(unrated.totalReviews).toBe(0);
    });

    it('[HP] returns all-zero stats when the washer has no orders', async () => {
      await seedProfile();
      const stats = await service.getStats(WASHER_UID);
      expect(stats).toMatchObject({
        slotsUsedToday: 0,
        activeOrders: 0,
        completedOrders: 0,
        completedOrdersToday: 0,
        totalKg: 0,
        totalLoads: 0,
        totalReviews: 0,
      });
    });

    it('[NE] exposes no legacy money aggregates on the stats payload', async () => {
      await seedProfile();
      const stats = await service.getStats(WASHER_UID);
      expect(stats).not.toHaveProperty('totalEarningsThisMonth');
      expect(stats).not.toHaveProperty('pendingEarnings');
      expect(stats).not.toHaveProperty('completedBookingsAllTime');
    });

    it('[NE] throws NotFound when the profile is missing', async () => {
      await expect(service.getStats(WASHER_UID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Legacy paths retired (GAP-P0-011)
  // -------------------------------------------------------------------------

  describe('legacy retirement', () => {
    it('[NE] legacy booking/earning/withdrawal service methods no longer exist', () => {
      const legacy = service as unknown as Record<string, unknown>;
      expect(legacy.getTodayBookings).toBeUndefined();
      expect(legacy.getBookingHistory).toBeUndefined();
      expect(legacy.updateBookingStatus).toBeUndefined();
      expect(legacy.getEarnings).toBeUndefined();
      expect(legacy.requestWithdrawal).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // updateProfile — operatingHours wiring
  // -------------------------------------------------------------------------

  describe('updateProfile (operatingHours)', () => {
    it('[HP] persists operatingHours to the profile', async () => {
      await seedProfile();
      const updated = await service.updateProfile(WASHER_UID, {
        operatingHours: makeOperatingHours(),
      });

      expect(updated.operatingHours).toBeDefined();
      expect(updated.operatingHours!.monday.isOpen).toBe(true);
      expect(updated.operatingHours!.monday.timeSlots[0]).toMatchObject({
        open: '08:00',
        close: '20:00',
      });
      expect(updated.operatingHours!.sunday.isOpen).toBe(false);

      const raw = await mongoConnection
        .collection('washer_profiles')
        .findOne({ uid: WASHER_UID });
      expect(raw!.operatingHours.friday.timeSlots[0].close).toBe('20:00');
    });

    // Hours are load-bearing now: the booking engine generates a washer's
    // bookable slots from them. normalizeWindows DROPS a reversed window rather
    // than complaining, so without this check "18:00–08:00" would silently
    // close the day and the only symptom would be no bookings on Tuesdays.
    it('[EDGE] rejects a window whose close is before its open', async () => {
      await seedProfile();
      await expect(
        service.updateProfile(WASHER_UID, {
          operatingHours: makeOperatingHours({
            tuesday: {
              isOpen: true,
              is24Hours: false,
              timeSlots: [{ open: '18:00', close: '08:00' }],
            },
          }),
        }),
      ).rejects.toThrow(/tuesday/);
    });

    it('[EDGE] rejects a zero-length window', async () => {
      await seedProfile();
      await expect(
        service.updateProfile(WASHER_UID, {
          operatingHours: makeOperatingHours({
            monday: {
              isOpen: true,
              is24Hours: false,
              timeSlots: [{ open: '09:00', close: '09:00' }],
            },
          }),
        }),
      ).rejects.toThrow(/monday/);
    });

    it('[HP] allows a 24-hour day with no time slots', async () => {
      await seedProfile();
      const updated = await service.updateProfile(WASHER_UID, {
        operatingHours: makeOperatingHours({
          monday: { isOpen: true, is24Hours: true, timeSlots: [] },
        }),
      });
      expect(updated.operatingHours!.monday.is24Hours).toBe(true);
    });

    it('[HP] leaves operatingHours untouched when not supplied', async () => {
      await seedProfile({ operatingHours: makeOperatingHours() });
      const updated = await service.updateProfile(WASHER_UID, {
        displayName: 'New Name',
      });
      expect(updated.displayName).toBe('New Name');
      expect(updated.operatingHours!.monday.isOpen).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // setDailyOrderCap — Admin's per-washer daily order cap
  // -------------------------------------------------------------------------

  describe('setDailyOrderCap', () => {
    it('[HP] sets the cap Admin chose', async () => {
      await seedProfile();
      const updated = await service.setDailyOrderCap('branch-1', 5);
      expect(updated.maxOrdersPerDay).toBe(5);
    });

    // Null is a real decision — "no per-washer cap" — not a request for a
    // default. Nothing stands in behind it.
    it('[HP] null clears the cap', async () => {
      await seedProfile({ maxOrdersPerDay: 5 });
      const updated = await service.setDailyOrderCap('branch-1', null);
      expect(updated.maxOrdersPerDay).toBeNull();
    });

    it('[NE] rejects 0 — stopping bookings is availability, not a cap of zero', async () => {
      await seedProfile();
      await expect(service.setDailyOrderCap('branch-1', 0)).rejects.toThrow(
        BadRequestException,
      );
      const untouched = await service.getProfile(WASHER_UID);
      expect(untouched.maxOrdersPerDay ?? null).toBeNull();
    });

    it('[NE] rejects a negative cap', async () => {
      await seedProfile();
      await expect(service.setDailyOrderCap('branch-1', -1)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('[NE] throws when no washer owns that branch', async () => {
      await seedProfile();
      await expect(service.setDailyOrderCap('branch-nope', 5)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // UpdateWasherProfileInput validation (class-validator, as the GraphQL
  // ValidationPipe would run it)
  // -------------------------------------------------------------------------

  describe('UpdateWasherProfileInput validation', () => {
    const toInput = (plain: Record<string, any>) =>
      plainToInstance(UpdateWasherProfileInput, plain);

    it('[HP] accepts a well-formed operatingHours payload', async () => {
      const errors = await validate(
        toInput({ operatingHours: makeOperatingHours() }),
      );
      expect(errors).toHaveLength(0);
    });

    it('[NE] rejects malformed HH:MM times', async () => {
      const bad = makeOperatingHours({
        monday: {
          isOpen: true,
          is24Hours: false,
          timeSlots: [{ open: '8am', close: '20:00' }],
        },
      });
      const errors = await validate(toInput({ operatingHours: bad }));
      expect(errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(errors)).toContain('open must be in HH:MM format');
    });

    it('[NE] rejects non-boolean isOpen / is24Hours flags', async () => {
      const bad = makeOperatingHours({
        tuesday: { isOpen: 'yes', is24Hours: false, timeSlots: [] },
      });
      const errors = await validate(toInput({ operatingHours: bad }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('[HP] still accepts an input with no operatingHours at all', async () => {
      const errors = await validate(toInput({ displayName: 'X' }));
      expect(errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // The whitelist trap.
  //
  // plainToInstance + validate() above CANNOT catch this: whitelisting is done
  // by the pipe, not by validate(). main.ts runs
  // `new ValidationPipe({ whitelist: true, transform: true })`, and whitelist
  // DELETES every property with no class-validator decorator — silently, with
  // no error. WasherMapLocationInput declared latitude/longitude with @Field
  // alone, so both were stripped after GraphQL had happily accepted them, and
  // the service rejected the pin for missing the very fields it was sent.
  // These tests run the real pipe so the next undecorated field is caught here
  // instead of on a device.
  // -------------------------------------------------------------------------

  describe('UpdateWasherProfileInput through the real ValidationPipe', () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const meta = {
      type: 'body' as const,
      metatype: UpdateWasherProfileInput,
      data: '',
    };

    it('[HP] survives whitelisting with both coordinates intact', async () => {
      const out = (await pipe.transform(
        { mapLocation: { latitude: 14.6001944, longitude: 121.0439947 } },
        meta,
      )) as UpdateWasherProfileInput;

      expect(out.mapLocation).toEqual({
        latitude: 14.6001944,
        longitude: 121.0439947,
      });
    });

    it('[NE] rejects a latitude outside -90..90 rather than storing it', async () => {
      await expect(
        pipe.transform({ mapLocation: { latitude: 91, longitude: 121 } }, meta),
      ).rejects.toThrow();
    });

    it('[NE] rejects a longitude outside -180..180', async () => {
      await expect(
        pipe.transform(
          { mapLocation: { latitude: 14.6, longitude: 181 } },
          meta,
        ),
      ).rejects.toThrow();
    });

    it('[NE] rejects a non-numeric coordinate', async () => {
      await expect(
        pipe.transform(
          { mapLocation: { latitude: 'here', longitude: 121 } },
          meta,
        ),
      ).rejects.toThrow();
    });

    it('[HP] omitting mapLocation entirely is still how you clear the pin', async () => {
      const out = (await pipe.transform(
        { serviceRadiusKm: 3 },
        meta,
      )) as UpdateWasherProfileInput;

      expect(out.mapLocation).toBeUndefined();
      expect(out.serviceRadiusKm).toBe(3);
    });

    // storeName is REQUIRED and unclearable: it is the only name her shop has,
    // and nothing falls back to her personal displayName any more. Omitting the
    // key still has to work, because every other washer screen sends a partial
    // patch through this same input.
    it('[HP] accepts a store name, trimmed', async () => {
      const out = (await pipe.transform(
        { storeName: '  Sparkle Suds Laundry  ' },
        meta,
      )) as UpdateWasherProfileInput;

      expect(out.storeName).toBe('Sparkle Suds Laundry');
    });

    it('[HP] omitting storeName leaves the stored name untouched', async () => {
      const out = (await pipe.transform(
        { serviceRadiusKm: 3 },
        meta,
      )) as UpdateWasherProfileInput;

      expect(out.storeName).toBeUndefined();
    });

    // The pipe throws BadRequestException with the per-field messages on its
    // response payload, not in `error.message` — assert on the payload so these
    // pin the ACTUAL rule that fired, not merely "something was rejected".
    const rejectionMessages = async (
      payload: Record<string, unknown>,
    ): Promise<string> => {
      try {
        await pipe.transform(payload, meta);
      } catch (err) {
        const res = (err as BadRequestException).getResponse();
        return JSON.stringify(res);
      }
      throw new Error('expected the pipe to reject this payload');
    };

    it('[NE] rejects an empty store name', async () => {
      expect(await rejectionMessages({ storeName: '' })).toContain(
        'storeName cannot be blank',
      );
    });

    it('[NE] rejects a whitespace-only store name', async () => {
      expect(await rejectionMessages({ storeName: '   ' })).toContain(
        'storeName cannot be blank',
      );
    });

    it('[NE] rejects null — a shop cannot be left nameless', async () => {
      expect(await rejectionMessages({ storeName: null })).toContain(
        'storeName',
      );
    });

    it('[NE] rejects a store name over 60 characters', async () => {
      expect(await rejectionMessages({ storeName: 'x'.repeat(61) })).toContain(
        'at most 60 characters',
      );
    });

    it('[HP] the nested address object survives whitelisting too', async () => {
      const out = (await pipe.transform(
        {
          address: {
            streetAddress: 'Xavier Street',
            barangayName: 'Baliw',
            cityMunicipalityName: 'San Juan',
            provinceName: 'Ilocos Sur',
            regionName: 'Ilocos Region',
          },
        },
        meta,
      )) as UpdateWasherProfileInput;

      expect(out.address).toMatchObject({
        streetAddress: 'Xavier Street',
        cityMunicipalityName: 'San Juan',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Certification evidence — private storage + guarded signed reads
  // (RISK-P0-002 residue)
  // -------------------------------------------------------------------------

  describe('certification evidence', () => {
    const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');
    const asUser = (uid: string, roleId: string) =>
      ({ _id: uid, role: { roleId } }) as unknown as User;

    const owner = asUser(WASHER_UID, 'washer');
    const otherWasher = asUser(OTHER_UID, 'washer');
    const admin = asUser('admin-1', 'admin');
    const support = asUser('support-1', 'support');
    const customer = asUser('cust-1', 'customer');

    it('[HP] stores evidence PRIVATELY under a server-derived key and drops public URLs', async () => {
      await seedProfile({ certProofUrls: ['https://public.example/old.jpg'] });

      await expect(
        service.submitCertificationProof(WASHER_UID, [
          { base64: PNG_BASE64, mimeType: 'image/png' },
        ]),
      ).resolves.toBe(true);

      expect(storageMock.uploadPrivate).toHaveBeenCalledTimes(1);
      expect(storageMock.upload).not.toHaveBeenCalled();
      const key = storageMock.uploadPrivate.mock.calls[0][1];
      expect(key).toMatch(/^cert-proofs\/washer\/[a-f0-9]{24}\/[\w-]+\.png$/);

      const profile = (await mongoConnection
        .collection('washer_profiles')
        .findOne({ uid: WASHER_UID }))!;
      expect(profile.certProofObjectKeys).toEqual([key]);
      expect(profile.certProofUrls).toEqual([]);
    });

    it('[NE] rejects a disallowed MIME type and an empty submission', async () => {
      await seedProfile();
      await expect(
        service.submitCertificationProof(WASHER_UID, [
          { base64: PNG_BASE64, mimeType: 'application/x-msdownload' },
        ]),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.submitCertificationProof(WASHER_UID, []),
      ).rejects.toThrow(BadRequestException);
      expect(storageMock.uploadPrivate).not.toHaveBeenCalled();
    });

    it('[HP] the owner gets short-lived signed URLs for her own evidence', async () => {
      await seedProfile({
        certProofObjectKeys: ['cert-proofs/washer/x/a.png'],
      });
      const urls = await service.certificationProofUrls(owner);
      expect(urls).toEqual([
        'https://signed.example/cert-proofs/washer/x/a.png',
      ]);
      expect(storageMock.getSignedReadUrl).toHaveBeenCalledWith(
        'cert-proofs/washer/x/a.png',
        300,
      );
    });

    it('[HP] admin and support may read another washer’s evidence', async () => {
      await seedProfile({
        certProofObjectKeys: ['cert-proofs/washer/x/a.png'],
      });
      await expect(
        service.certificationProofUrls(admin, WASHER_UID),
      ).resolves.toHaveLength(1);
      await expect(
        service.certificationProofUrls(support, WASHER_UID),
      ).resolves.toHaveLength(1);
    });

    it('[SEC] a different washer, and any other non-reviewer, are denied', async () => {
      await seedProfile({
        certProofObjectKeys: ['cert-proofs/washer/x/a.png'],
      });
      await expect(
        service.certificationProofUrls(otherWasher, WASHER_UID),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.certificationProofUrls(customer, WASHER_UID),
      ).rejects.toThrow(ForbiddenException);
      expect(storageMock.getSignedReadUrl).not.toHaveBeenCalled();
      // Anonymous callers never reach the service at all — GqlAuthGuard
      // rejects them before resolution (not exercised here by design).
    });

    it('[HP] not-yet-migrated legacy public URLs still read through the guarded query', async () => {
      await seedProfile({
        certProofObjectKeys: ['cert-proofs/washer/x/a.png'],
        certProofUrls: ['https://public.example/legacy.jpg'],
      });
      const urls = await service.certificationProofUrls(owner);
      expect(urls).toEqual([
        'https://signed.example/cert-proofs/washer/x/a.png',
        'https://public.example/legacy.jpg',
      ]);
    });
  });
});
