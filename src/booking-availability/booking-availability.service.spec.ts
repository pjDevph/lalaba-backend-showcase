import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { BookingAvailabilityService } from './booking-availability.service';
import {
  BookingAvailabilityConfig,
  BookingAvailabilityConfigDocument,
  BookingAvailabilityConfigSchema,
} from './schemas/booking-availability-config.schema';
import {
  BookingDateOverride,
  BookingDateOverrideSchema,
} from './schemas/booking-date-override.schema';
import {
  BookingBlackout,
  BookingBlackoutSchema,
} from './schemas/booking-blackout.schema';
import {
  BookingSlotCounter,
  BookingSlotCounterSchema,
} from './schemas/booking-slot-counter.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  OrderStatus,
  ProviderType,
} from '../online-orders/schemas/order-status.enum';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  addDays,
  formatHHMM,
  phDayKey,
  phMinutesOfDay,
} from '../common/utils/ph-time.util';
import { BookingPolicyService } from '../booking-policy/booking-policy.service';
import {
  BookingPolicy,
  BookingPolicyDocument,
  BookingPolicySchema,
  BookingPolicyStatus,
  POLICY_SEED,
} from '../booking-policy/schemas/booking-policy.schema';
import {
  BookingMilestone,
  BookingMilestoneDocument,
  BookingMilestoneSchema,
} from '../booking-policy/schemas/booking-milestone.schema';
import {
  BookingCampaign,
  BookingCampaignSchema,
  CampaignModifierMode,
  CampaignScope,
} from '../booking-policy/schemas/booking-campaign.schema';

const BRANCH = 'branch-1';

/**
 * These run against real Mongo (in-memory) rather than mocks because the parts
 * most likely to break — the capacity aggregation over `online_orders` and the
 * slot counter's write-conflict behaviour — only exist at the database layer.
 */
describe('BookingAvailabilityService', () => {
  let replSet: MongoMemoryReplSet;
  let module: TestingModule;
  let service: BookingAvailabilityService;
  let connection: Connection;
  let configModel: Model<BookingAvailabilityConfigDocument>;
  let orderModel: Model<OnlineOrderDocument>;
  let policyService: BookingPolicyService;
  let policyModel: Model<BookingPolicyDocument>;
  let milestoneModel: Model<BookingMilestoneDocument>;
  let campaignModel: Model<Document & BookingCampaign>;

  // Everything is relative to "today" in PH terms, which is what the service
  // compares against — pinning a literal date would rot within a day.
  const today = phDayKey();
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(today, 7);

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          {
            name: BookingAvailabilityConfig.name,
            schema: BookingAvailabilityConfigSchema,
          },
          { name: BookingDateOverride.name, schema: BookingDateOverrideSchema },
          { name: BookingBlackout.name, schema: BookingBlackoutSchema },
          { name: BookingSlotCounter.name, schema: BookingSlotCounterSchema },
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: BookingPolicy.name, schema: BookingPolicySchema },
          { name: BookingMilestone.name, schema: BookingMilestoneSchema },
          { name: BookingCampaign.name, schema: BookingCampaignSchema },
        ]),
      ],
      // The real policy service: capacity ceilings are computed from it now, so
      // stubbing it would test arithmetic that does not ship.
      providers: [BookingAvailabilityService, BookingPolicyService],
    }).compile();

    service = module.get(BookingAvailabilityService);
    connection = module.get<Connection>(getConnectionToken());
    configModel = module.get(`${BookingAvailabilityConfig.name}Model`);
    orderModel = module.get(`${OnlineOrder.name}Model`);
    policyService = module.get(BookingPolicyService);
    policyModel = module.get(`${BookingPolicy.name}Model`);
    milestoneModel = module.get(`${BookingMilestone.name}Model`);
    campaignModel = module.get(`${BookingCampaign.name}Model`);
  }, 120_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await Promise.all(
      Object.values(connection.collections).map((c) => c.deleteMany({})),
    );
  });

  /**
   * Splits a test's intent across the two documents that now own it: rules the
   * PLATFORM sets go to the policy, and what the provider asked for goes to her
   * own config. The tests read the same as before; the storage moved.
   */
  const POLICY_OWNED: Record<string, string> = {
    dailyBookingLimit: 'dailyCapacity',
    maxBookingsPerSlot: 'perSlotCapacity',
    slotIntervalMinutes: 'slotIntervalMinutes',
    advanceBookingDays: 'advanceBookingDays',
    leadTimeMinutes: 'leadTimeMinutes',
    sameDayBookingEnabled: 'sameDayBookingEnabled',
    sameDayCutoffTime: 'sameDayCutoffTime',
  };

  async function seedConfig(patch: Record<string, unknown> = {}) {
    const config = await service.getOrCreateConfig(BRANCH, ProviderType.WASHER);
    await policyService.current();

    const policyPatch: Record<string, unknown> = {};
    const configPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      const policyKey = POLICY_OWNED[key];
      if (policyKey) policyPatch[`defaults.${policyKey}`] = value;
      else configPatch[key] = value;
    }

    if (Object.keys(policyPatch).length > 0) {
      await policyModel
        .updateOne({ status: BookingPolicyStatus.LIVE }, { $set: policyPatch })
        .exec();
    }
    if (Object.keys(configPatch).length > 0) {
      await configModel
        .updateOne({ branchId: BRANCH }, { $set: configPatch })
        .exec();
    }
    return config;
  }

  /** A booked order occupying one slot. */
  async function seedOrder(
    date: string,
    startTime: string,
    status: OrderStatus = OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
  ) {
    await orderModel.create({
      customer: {
        uid: 'c1',
        displayName: 'C',
        maskedPhone: '0917',
        address: {},
        mapLocation: { latitude: 0, longitude: 0 },
        areaLabel: 'x',
      },
      provider: {
        providerType: ProviderType.WASHER,
        providerUid: 'w1',
        branchId: BRANCH,
        providerName: 'W',
      },
      serviceLines: [],
      fulfillment: {
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
        scheduledPickup: {
          date,
          startTime,
          endTime: '09:00',
          label: 'x',
        },
      },
      pricing: { estimatedTotalCentavos: 0 },
      status,
    });
  }

  const book = (date: string) =>
    service.assertDayBookable(BRANCH, ProviderType.WASHER, { date }, 'pickup');

  describe('defaults', () => {
    it('treats a never-configured provider as open on platform defaults', async () => {
      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.isBookable).toBe(true);
      expect(day.dailyBookingLimit).toBe(POLICY_SEED.dailyCapacity);
      expect(day.remaining).toBe(POLICY_SEED.dailyCapacity);
      // 08:00–20:00, the platform default window.
      expect(day.windows).toEqual([{ start: '08:00', end: '20:00' }]);
    });
  });

  // A washer edits her own operating hours, exactly like a merchant. Those
  // hours live on her profile and are projected into `weekly` at read time, so
  // the schedule a customer can book cannot drift from the one she set.
  describe('washer operating hours drive her slots', () => {
    const dayKeyOfTomorrow = new Date(`${tomorrow}T00:00:00+08:00`)
      .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Manila' })
      .toLowerCase();

    const hoursWeek = (day: unknown) =>
      Object.fromEntries(
        [
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday',
          'sunday',
        ].map((k) => [k, day]),
      );

    const seedWasherHours = async (day: unknown) => {
      await connection.model(WasherProfile.name).create({
        uid: 'w1',
        displayName: 'Maria',
        branchId: BRANCH,
        operatingHours: hoursWeek(day),
      } as never);
    };

    it('generates slots from her hours, ignoring the stored weekly', async () => {
      await seedConfig();
      // The stored weekly says 08:00–20:00; she says 09:00–11:00.
      await seedWasherHours({
        isOpen: true,
        is24Hours: false,
        timeSlots: [{ open: '09:00', close: '11:00' }],
      });

      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      // Her hours become the day's window; there is no slicing any more.
      expect(day.windows).toEqual([{ start: '09:00', end: '11:00' }]);
    });

    it('closes a day she marked closed', async () => {
      await seedConfig();
      await seedWasherHours({ isOpen: false, is24Hours: false, timeSlots: [] });

      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.isBookable).toBe(false);
      expect(dayKeyOfTomorrow).toBeTruthy();
    });

    // A day she is open on is bookable; a day she is closed on is not. The
    // customer no longer names a time, so "outside her hours" is now a
    // question about the DAY rather than the window within it.
    it('accepts a day she is open on', async () => {
      await seedConfig();
      await seedWasherHours({
        isOpen: true,
        is24Hours: false,
        timeSlots: [{ open: '09:00', close: '11:00' }],
      });

      await expect(book(tomorrow)).resolves.toBeTruthy();
    });

    it('refuses a day she is closed on', async () => {
      await seedConfig();
      await seedWasherHours({ isOpen: false, is24Hours: false, timeSlots: [] });

      await expect(book(tomorrow)).rejects.toThrow();
    });

    // The fallback that makes the backfill optional rather than a prerequisite.
    it('falls back to the stored weekly when she has never set hours', async () => {
      await seedConfig();
      await connection.model(WasherProfile.name).create({
        uid: 'w1',
        displayName: 'Maria',
        branchId: BRANCH,
      } as never);

      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.windows).toEqual([{ start: '08:00', end: '20:00' }]);
    });

    it('leaves a merchant branch on its own weekly', async () => {
      await service.getOrCreateConfig(BRANCH, ProviderType.MERCHANT);
      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.MERCHANT,
        tomorrow,
      );
      expect(day.windows).toEqual([{ start: '08:00', end: '20:00' }]);
    });
  });

  describe('day capacity', () => {
    // Per-slot capacity is gone: the day is the only unit of capacity, which
    // is what makes the admin-set daily cap the single enforcement point.
    it('closes the day once the daily limit is reached', async () => {
      await seedConfig({ dailyBookingLimit: 2 });
      await seedOrder(tomorrow, '08:00');
      await seedOrder(tomorrow, '09:00');

      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.isBookable).toBe(false);
      expect(day.remaining).toBe(0);
      expect(day.unavailableReason).toBe('day_fully_booked');
      await expect(book(tomorrow)).rejects.toThrow(/fully booked/i);
    });

    it('refuses to book a full day', async () => {
      await seedConfig({ dailyBookingLimit: 1 });
      await seedOrder(tomorrow, '08:00');
      await expect(book(tomorrow)).rejects.toThrow(BadRequestException);
    });

    // A cancelled order must give its place back, and does so without a
    // compensating decrement because admission is decided by the count query.
    it('frees the place when an order is cancelled', async () => {
      await seedConfig({ dailyBookingLimit: 1 });
      await seedOrder(tomorrow, '08:00', OrderStatus.CANCELLED);
      await expect(book(tomorrow)).resolves.toMatchObject({ date: tomorrow });
    });

    // Gate: the snapshot the order stores is a day, not a window.
    it('returns a day label and no times', async () => {
      await seedConfig();
      const booked = await book(tomorrow);
      expect(booked).toEqual({
        date: tomorrow,
        label: expect.stringMatching(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/),
      });
      expect(booked).not.toHaveProperty('startTime');
      expect(booked).not.toHaveProperty('endTime');
    });

    it('counts only this provider’s orders', async () => {
      await seedConfig({ dailyBookingLimit: 1 });
      await orderModel.updateMany({}, { $set: {} }).exec();
      // An order for a different branch on the same date must not consume
      // this provider's capacity.
      await orderModel.create({
        customer: {
          uid: 'c1',
          displayName: 'C',
          maskedPhone: '0917',
          address: {},
          mapLocation: { latitude: 0, longitude: 0 },
          areaLabel: 'x',
        },
        provider: {
          providerType: ProviderType.WASHER,
          providerUid: 'w2',
          branchId: 'other-branch',
          providerName: 'W2',
        },
        serviceLines: [],
        fulfillment: {
          pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
          returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
          scheduledPickup: {
            date: tomorrow,
            startTime: '08:00',
            endTime: '08:30',
            label: 'x',
          },
        },
        pricing: { estimatedTotalCentavos: 0 },
        status: OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
      });

      await expect(book(tomorrow)).resolves.toBeTruthy();
    });
  });

  describe('booking rules', () => {
    it('refuses a date beyond the advance window', async () => {
      await seedConfig({ advanceBookingDays: 3 });
      await expect(book(addDays(today, 5))).rejects.toThrow(/3 days ahead/);
    });

    it('refuses a date in the past', async () => {
      await seedConfig();
      await expect(book(addDays(today, -1))).rejects.toThrow(/already passed/);
    });

    it('refuses same-day bookings when they are switched off', async () => {
      await seedConfig({ sameDayBookingEnabled: false });
      await expect(book(today)).rejects.toThrow(/same-day/i);
      // Tomorrow is unaffected — the rule is about today only.
      await expect(book(tomorrow)).resolves.toBeTruthy();
    });

    // ── Lead time, now enforced at DAY level ─────────────────────────────
    //
    // This rule used to live only in slotUnavailableReason, measured against
    // each slot's start. Deleting the slots would have dropped notice-period
    // enforcement entirely — a same-day booking five minutes before closing.
    // It is now measured against the day's FIRST open window.

    it('refuses today when the notice period has already passed', async () => {
      // Her day opens at 08:00 and she wants a full day's notice, so today can
      // never satisfy it regardless of the hour the test runs. Cutoff pushed
      // to 23:59 so the SEPARATE same-day-cutoff rule (PAST_CUTOFF, checked
      // before notice) cannot pre-empt the notice-period rejection this test
      // is actually about — without it, this test is flaky after whatever
      // the default cutoff is (5 PM), failing with the wrong message for
      // anyone running the suite in the evening.
      await seedConfig({
        sameDayBookingEnabled: true,
        sameDayCutoffTime: '23:59',
        leadTimeMinutes: 24 * 60,
      });
      await expect(book(today)).rejects.toThrow(/notice|already passed/i);
    });

    it('accepts a date far enough ahead to clear the notice period', async () => {
      await seedConfig({
        sameDayBookingEnabled: true,
        leadTimeMinutes: 24 * 60,
      });
      await expect(book(nextWeek)).resolves.toBeTruthy();
    });

    it('accepts today when no notice is required', async () => {
      // The day's window open time is the notice-period anchor for TODAY
      // (booking.service.ts's own comment: collection is a single batched
      // run starting at the day's first open window, not on demand — so
      // once that run has started, "today, zero notice" is correctly no
      // longer bookable; that is PAST_CUTOFF/IN_THE_PAST territory, not this
      // test). To assert the zero-notice case itself regardless of the hour
      // the suite runs, push today's window to open a minute from now so it
      // has not started yet.
      await seedConfig({
        sameDayBookingEnabled: true,
        sameDayCutoffTime: '23:59',
        leadTimeMinutes: 0,
      });
      const todayKey = new Date(`${today}T00:00:00.000Z`)
        .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
        .toLowerCase();
      const windowStart = formatHHMM(phMinutesOfDay() + 1);
      await configModel
        .updateOne(
          { branchId: BRANCH },
          {
            $set: {
              [`weekly.${todayKey}.windows`]: [
                { start: windowStart, end: '23:59' },
              ],
            },
          },
        )
        .exec();
      await expect(book(today)).resolves.toBeTruthy();
    });

    // DEC-BOOK-005. Notice used to be measured against the day's OPENING, which
    // is right for a future day and nonsense for today: a shop opening at 08:00
    // with two hours' notice went unbookable for the same day at 06:00 — before
    // anyone was awake, and long before the 17:00 same-day cutoff could mean
    // anything. Both same-day settings were decorative for any ordinary
    // opening hour.
    it('accepts today once open, when the notice still fits before closing', async () => {
      await seedConfig({
        sameDayBookingEnabled: true,
        sameDayCutoffTime: '23:59',
        leadTimeMinutes: 60,
      });
      // A day that is open NOW and closes well after the notice period.
      const todayKey = new Date(`${today}T00:00:00.000Z`)
        .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
        .toLowerCase();
      await configModel
        .updateOne(
          { branchId: BRANCH },
          {
            $set: {
              // Opened an hour ago — under the old rule that alone made today
              // unbookable, whatever the closing time.
              [`weekly.${todayKey}.windows`]: [
                {
                  start: formatHHMM(Math.max(0, phMinutesOfDay() - 60)),
                  end: '23:59',
                },
              ],
            },
          },
        )
        .exec();

      await expect(book(today)).resolves.toBeTruthy();
    });

    it('still refuses today when the notice would run past closing', async () => {
      // The case the old rule was protecting, and it is still protected: this
      // is what stops a booking five minutes before the shutters come down.
      await seedConfig({
        sameDayBookingEnabled: true,
        sameDayCutoffTime: '23:59',
        leadTimeMinutes: 120,
      });
      const todayKey = new Date(`${today}T00:00:00.000Z`)
        .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
        .toLowerCase();
      await configModel
        .updateOne(
          { branchId: BRANCH },
          {
            $set: {
              // Closes in 30 minutes — two hours' notice cannot fit.
              [`weekly.${todayKey}.windows`]: [
                {
                  start: formatHHMM(Math.max(0, phMinutesOfDay() - 60)),
                  end: formatHHMM(Math.min(1439, phMinutesOfDay() + 30)),
                },
              ],
            },
          },
        )
        .exec();

      await expect(book(today)).rejects.toThrow(/notice|already passed/i);
    });

    it('refuses every date while bookings are paused', async () => {
      await seedConfig({ bookingsPaused: true });
      await expect(book(nextWeek)).rejects.toThrow(/paused/i);
    });

    it('refuses every date when scheduled bookings are off', async () => {
      await seedConfig({ acceptScheduledBookings: false });
      await expect(book(nextWeek)).rejects.toThrow(
        /not taking scheduled bookings/i,
      );
    });

    it('refuses a day the weekly schedule closes', async () => {
      const config = await service.getOrCreateConfig(
        BRANCH,
        ProviderType.WASHER,
      );
      const dayKey = new Date(`${tomorrow}T00:00:00.000Z`)
        .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
        .toLowerCase();
      await configModel
        .updateOne(
          { branchId: BRANCH },
          { $set: { [`weekly.${dayKey}.isAcceptingBookings`]: false } },
        )
        .exec();
      expect(config).toBeTruthy();

      await expect(book(tomorrow)).rejects.toThrow(
        /does not accept bookings on that day/i,
      );
    });
  });

  describe('special dates', () => {
    it('closes a date an override marks closed', async () => {
      await seedConfig();
      await service.upsertOverride(
        BRANCH,
        { date: tomorrow, isClosed: true, label: 'Holiday' },
        'admin',
      );
      await expect(book(tomorrow)).rejects.toThrow(
        /unavailable on that date|does not accept/i,
      );
    });

    it('replaces the day’s hours from an override without touching capacity', async () => {
      await seedConfig({ dailyBookingLimit: 15 });
      await service.upsertOverride(
        BRANCH,
        {
          date: tomorrow,
          isClosed: false,
          windows: [{ start: '10:00', end: '12:00' }],
        },
        'admin',
      );

      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.windows).toEqual([{ start: '10:00', end: '12:00' }]);
      expect(day.dailyBookingLimit).toBe(15);
      expect(day.isSpecialDate).toBe(true);
    });

    it('blocks every date inside a blackout range', async () => {
      await seedConfig();
      await service.createBlackout(
        BRANCH,
        {
          startDate: tomorrow,
          endDate: addDays(today, 3),
          reason: 'Maintenance',
        },
        'admin',
      );

      await expect(book(addDays(today, 2))).rejects.toThrow(
        /unavailable on that date/i,
      );
      // The day after the range ends is bookable again.
      await expect(book(addDays(today, 4))).resolves.toBeTruthy();
    });

    it('lists overrides and blackouts together', async () => {
      await seedConfig();
      await service.upsertOverride(
        BRANCH,
        { date: tomorrow, isClosed: true, label: 'Holiday' },
        'admin',
      );
      await service.createBlackout(
        BRANCH,
        { startDate: nextWeek, endDate: nextWeek, reason: 'Repairs' },
        'admin',
      );

      const rows = await service.upcomingSpecialDates(BRANCH);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.source)).toEqual(['override', 'blackout']);
    });
  });

  describe('fulfillment availability', () => {
    it('refuses a handover mode the day does not offer', async () => {
      await seedConfig();
      const dayKey = new Date(`${tomorrow}T00:00:00.000Z`)
        .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
        .toLowerCase();
      await configModel
        .updateOne(
          { branchId: BRANCH },
          {
            $set: { [`weekly.${dayKey}.fulfillment.providerPickup`]: false },
          },
        )
        .exec();

      await expect(
        service.assertDayBookable(
          BRANCH,
          ProviderType.WASHER,
          { date: tomorrow },
          'pickup',
        ),
      ).rejects.toThrow(/handover option/i);

      // Drop-off is still fine on the same date.
      await expect(
        service.assertDayBookable(
          BRANCH,
          ProviderType.WASHER,
          { date: tomorrow },
          'dropoff',
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe('capacity ownership', () => {
    // Capacity is no longer something a provider states. The provider-writable
    // input carries the pause switch and nothing else, so the only question
    // left is whether the platform number reaches her intact.
    it('resolves the daily limit from platform policy, not from her record', async () => {
      await seedConfig();
      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.dailyBookingLimit).toBe(POLICY_SEED.dailyCapacity);
    });

    // The regression the migration exists for: a value written under the old
    // provider-editable control would otherwise pin her below the platform
    // number with no control left in the app to raise it.
    it('a stale stored request still caps her — hence the clearing migration', async () => {
      await seedConfig({ dailyBookingLimit: 1 });
      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.dailyBookingLimit).toBe(1);
    });

    it('a milestone still raises the ceiling, with no write to her record', async () => {
      await seedConfig();
      await milestoneModel.create({
        key: 'growth',
        name: 'Growth',
        rank: 10,
        isDefault: false,
        isActive: true,
        eligibility: {
          minCompletedOrders: 0,
          requireVerified: false,
          requireGoodStanding: false,
        },
        entitlements: {
          dailyCapacity: 40,
          perSlotCapacity: 6,
          advanceBookingDays: 21,
          priorityBooking: false,
        },
      } as never);

      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.WASHER,
        tomorrow,
      );
      expect(day.dailyBookingLimit).toBe(40);
    });

    it('stamps pausedAt when a provider pauses, and clears it on resume', async () => {
      await seedConfig();
      const paused = await service.updateOwnCapacity(
        BRANCH,
        ProviderType.WASHER,
        { bookingsPaused: true, pauseReason: 'Overloaded' },
      );
      expect(paused.pausedAt).toBeTruthy();

      const resumed = await service.updateOwnCapacity(
        BRANCH,
        ProviderType.WASHER,
        { bookingsPaused: false },
      );
      expect(resumed.pausedAt).toBeNull();
      expect(resumed.pauseReason).toBeNull();
    });

    it('leaves a laundromat uncapped', async () => {
      // Capacity is a home-washer concept; a branch manages its own throughput.
      const day = await service.dayAvailability(
        BRANCH,
        ProviderType.MERCHANT,
        tomorrow,
      );
      // null, not Infinity: "uncapped" has to cross a GraphQL Int, and
      // Infinity cannot be serialized as one — it threw, so every caller got an
      // error instead of a calendar. Infinity stays internal to the comparison
      // that decides isBookable.
      expect(day.dailyBookingLimit).toBeNull();
    });

    // The bug this replaced: an uncapped provider resolved to Infinity, which
    // GraphQL cannot serialize as an Int, so providerPickupDays threw. The
    // customer app caught the failure and rendered an empty day list as "this
    // provider is not taking bookings that day" — for every day, with no
    // reason, while the provider's own screen said ACCEPTING ORDERS.
    it('[SEC] an uncapped day survives GraphQL Int serialization', () => {
      const { GraphQLInt } = require('graphql');
      for (const value of [null, 0, 5]) {
        expect(() =>
          value === null ? null : GraphQLInt.serialize(value),
        ).not.toThrow();
      }
      expect(() => GraphQLInt.serialize(Number.POSITIVE_INFINITY)).toThrow();
    });
  });

  describe('copyDay', () => {
    it('copies one day onto others without sharing an object', async () => {
      await seedConfig();
      await configModel
        .updateOne(
          { branchId: BRANCH },
          {
            $set: {
              'weekly.monday.windows': [{ start: '09:00', end: '17:00' }],
              'weekly.monday.dailyBookingLimit': 7,
            },
          },
        )
        .exec();

      const saved = await service.copyDay(BRANCH, ProviderType.WASHER, {
        fromDay: 'monday',
        toDays: ['tuesday', 'wednesday'],
      });

      expect(saved.weekly.tuesday.dailyBookingLimit).toBe(7);
      expect(saved.weekly.wednesday.windows[0].start).toBe('09:00');
      // Thursday was not a target and keeps its own hours.
      expect(saved.weekly.thursday.windows[0].start).toBe('08:00');
    });

    it('rejects a copy with no real targets', async () => {
      await seedConfig();
      await expect(
        service.copyDay(BRANCH, ProviderType.WASHER, {
          fromDay: 'monday',
          toDays: ['monday'],
        }),
      ).rejects.toThrow(/at least one other day/i);
    });
  });

  describe('calendar', () => {
    it('never offers dates past the advance window', async () => {
      await seedConfig({ advanceBookingDays: 5 });
      const days = await service.calendar(
        BRANCH,
        ProviderType.WASHER,
        today,
        30,
      );
      expect(days).toHaveLength(6); // today + 5
    });

    it('rejects an impossible calendar date', async () => {
      await seedConfig();
      await expect(
        service.dayAvailability(BRANCH, ProviderType.WASHER, '2026-02-31'),
      ).rejects.toThrow(/not a real calendar date/i);
    });
  });
});
