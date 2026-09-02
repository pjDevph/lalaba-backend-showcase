import {
  dayFulfillmentOf,
  effectiveDay,
  intersectWindows,
  normalizeWindows,
  summarize,
  weeklyFromOperatingHours,
} from './availability-resolution.util';
import { BookingAvailabilityConfig } from './schemas/booking-availability-config.schema';
import { BookingDateOverride } from './schemas/booking-date-override.schema';
import { EffectiveEntitlement } from '../booking-policy/entitlement.util';
import { ProviderType } from '../online-orders/schemas/order-status.enum';

/**
 * Entitlement is an INPUT to resolution now. The provider document carries only
 * what she ASKED for; what she is ALLOWED comes from the platform policy, so a
 * test that wants a different ceiling changes this, not the config.
 */
const ENTITLED: EffectiveEntitlement = {
  dailyCapacity: 20,
  advanceBookingDays: 14,
  leadTimeMinutes: 120,
  sameDayBookingEnabled: true,
  sameDayCutoffTime: '16:00',
  bookingsEnabled: true,
  milestoneKey: 'starter',
  milestoneName: 'Starter',
  appliedCampaignIds: [],
  appliedCampaignNames: [],
  cappedBySafetyLimit: false,
  steps: [],
};

const entitledWith = (
  over: Partial<EffectiveEntitlement>,
): EffectiveEntitlement => ({ ...ENTITLED, ...over });

const fullDay = (over: Record<string, unknown> = {}) => ({
  isAcceptingBookings: true,
  windows: [{ start: '08:00', end: '20:00' }],
  dailyBookingLimit: null,
  fulfillment: {
    providerPickup: true,
    providerDelivery: true,
    customerDropoff: true,
    customerPickup: true,
    pickupWindows: [],
    dropoffWindows: [],
  },
  ...over,
});

function makeConfig(
  over: Record<string, unknown> = {},
): BookingAvailabilityConfig {
  return {
    _id: 'cfg1',
    branchId: 'b1',
    providerType: ProviderType.WASHER,
    acceptScheduledBookings: true,
    fulfillmentPricing: {
      providerPickup: { feeCentavos: 0, premiumWindowFeeCentavos: null },
      providerDelivery: { feeCentavos: 0, premiumWindowFeeCentavos: null },
      express: { enabled: false, feeCentavos: 12000, slaHours: 4 },
    },
    bookingsPaused: false,
    weekly: {
      monday: fullDay(),
      tuesday: fullDay(),
      wednesday: fullDay(),
      thursday: fullDay(),
      friday: fullDay(),
      saturday: fullDay({ windows: [{ start: '09:00', end: '17:00' }] }),
      sunday: fullDay({ isAcceptingBookings: false }),
    },
    dailyBookingLimit: null,
    ...over,
  };
}

const week = (config: BookingAvailabilityConfig) =>
  config.weekly as unknown as Record<string, unknown>;

describe('normalizeWindows', () => {
  it('drops windows that end before they start', () => {
    expect(normalizeWindows([{ start: '18:00', end: '09:00' }])).toEqual([]);
  });

  it('drops malformed times rather than emitting NaN slots', () => {
    expect(
      normalizeWindows([
        { start: '25:00', end: '26:00' },
        { start: '8:0', end: '9:00' },
      ]),
    ).toEqual([]);
  });

  // Two overlapping windows would otherwise produce the same slot start twice,
  // and a duplicated start collides on the slot counter's unique key.
  it('merges overlapping windows into one', () => {
    expect(
      normalizeWindows([
        { start: '08:00', end: '12:00' },
        { start: '11:00', end: '15:00' },
      ]),
    ).toEqual([{ start: '08:00', end: '15:00' }]);
  });

  it('keeps a genuine split shift separate', () => {
    expect(
      normalizeWindows([
        { start: '14:00', end: '20:00' },
        { start: '08:00', end: '12:00' },
      ]),
    ).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '14:00', end: '20:00' },
    ]);
  });
});

describe('effectiveDay — capacity comes from the entitlement', () => {
  it('gives a provider her full entitlement when she asks for nothing', () => {
    const day = effectiveDay(makeConfig(), 'monday', ENTITLED);
    expect(day.dailyBookingLimit).toBe(20);
  });

  it('honours a provider throttling herself below her entitlement', () => {
    const day = effectiveDay(
      makeConfig({ dailyBookingLimit: 5 }),
      'monday',
      ENTITLED,
    );
    expect(day.dailyBookingLimit).toBe(5);
  });

  // The whole point of computing rather than storing: a stale higher number
  // written while she was on a better tier must not survive a demotion.
  it('caps a provider request that exceeds her entitlement', () => {
    const day = effectiveDay(
      makeConfig({ dailyBookingLimit: 50 }),
      'monday',
      ENTITLED,
    );
    expect(day.dailyBookingLimit).toBe(20);
  });

  // And the mirror image: a campaign lifts every inherited number without a
  // single write to this provider's document.
  it('lifts an un-throttled provider when a campaign raises her tier', () => {
    const day = effectiveDay(
      makeConfig(),
      'monday',
      entitledWith({ dailyCapacity: 40 }),
    );
    expect(day.dailyBookingLimit).toBe(40);
  });

  it('leaves a self-throttled provider where she put herself during a campaign', () => {
    const day = effectiveDay(
      makeConfig({ dailyBookingLimit: 8 }),
      'monday',
      entitledWith({ dailyCapacity: 40 }),
    );
    expect(day.dailyBookingLimit).toBe(8);
  });

  it('leaves a laundromat uncapped', () => {
    const day = effectiveDay(
      makeConfig(),
      'monday',
      entitledWith({ dailyCapacity: null }),
    );
    expect(day.dailyBookingLimit).toBe(Number.POSITIVE_INFINITY);
  });

  it('lets one weekday cap itself below the rest', () => {
    const config = makeConfig();
    week(config).saturday = fullDay({
      windows: [{ start: '09:00', end: '17:00' }],
      dailyBookingLimit: 12,
    });
    const day = effectiveDay(config, 'saturday', ENTITLED);
    expect(day.dailyBookingLimit).toBe(12);
  });
});

describe('effectiveDay — schedule', () => {
  it('closes the day when the weekday is not accepting bookings', () => {
    expect(
      effectiveDay(makeConfig(), 'sunday', ENTITLED).isAcceptingBookings,
    ).toBe(false);
  });

  it('lets a date override close an otherwise open day', () => {
    const override = {
      isClosed: true,
      windows: [],
    } as unknown as BookingDateOverride;
    const day = effectiveDay(makeConfig(), 'monday', ENTITLED, override);
    expect(day.isAcceptingBookings).toBe(false);
    expect(day.isSpecialDate).toBe(true);
  });

  it('lets an override replace hours without restating capacity', () => {
    const override = {
      isClosed: false,
      windows: [{ start: '10:00', end: '16:00' }],
      label: 'Special schedule',
    } as unknown as BookingDateOverride;
    const day = effectiveDay(makeConfig(), 'monday', ENTITLED, override);
    expect(day.windows).toEqual([{ start: '10:00', end: '16:00' }]);
    expect(day.dailyBookingLimit).toBe(20);
    expect(day.specialDateLabel).toBe('Special schedule');
  });

  it('lets an override cut capacity while keeping the weekday hours', () => {
    const override = {
      isClosed: false,
      windows: [],
      dailyBookingLimit: 8,
    } as unknown as BookingDateOverride;
    const day = effectiveDay(makeConfig(), 'monday', ENTITLED, override);
    expect(day.dailyBookingLimit).toBe(8);
    expect(day.windows).toEqual([{ start: '08:00', end: '20:00' }]);
  });

  // A provider who never configured Wednesday must not silently lose Wednesday.
  it('falls back to the platform window for a missing weekday', () => {
    const config = makeConfig();
    delete week(config).wednesday;
    const day = effectiveDay(config, 'wednesday', ENTITLED);
    expect(day.isAcceptingBookings).toBe(true);
    expect(day.windows).toEqual([{ start: '08:00', end: '20:00' }]);
  });
});

describe('summarize', () => {
  it('collapses identical consecutive days into one line', () => {
    const summary = summarize(makeConfig(), ENTITLED);
    expect(summary.scheduleLines).toEqual([
      'Mon–Fri  8:00 AM – 8:00 PM',
      'Sat  9:00 AM – 5:00 PM',
      'Sun  Closed',
    ]);
  });

  it('states every rule in plain language', () => {
    const summary = summarize(makeConfig(), ENTITLED);
    expect(summary.ruleLines).toEqual([
      'Maximum 20 bookings per day',
      'Minimum notice: 2 hours',
      'Same-day cutoff: 4:00 PM',
      'Customers may book 14 days ahead',
    ]);
  });

  // The summary must reflect a live campaign immediately, which it can only do
  // because it reads the entitlement rather than a stored number.
  it('reflects a campaign that doubled capacity, with no config change', () => {
    const summary = summarize(
      makeConfig(),
      entitledWith({ dailyCapacity: 40 }),
    );
    expect(summary.ruleLines).toContain('Maximum 40 bookings per day');
    // A customer picks a DAY, so there is no interval or per-slot line left to
    // state — and nothing in the summary should imply one.
    expect(summary.ruleLines.some((l) => l.includes('per slot'))).toBe(false);
    expect(summary.ruleLines.some((l) => l.includes('interval'))).toBe(false);
  });

  it('reports a paused provider as paused, not as closed', () => {
    const summary = summarize(makeConfig({ bookingsPaused: true }), ENTITLED);
    expect(summary.stateLabel).toBe('Bookings paused');
    expect(summary.isAcceptingBookings).toBe(false);
  });

  it('distinguishes bookings switched off from bookings paused', () => {
    const summary = summarize(
      makeConfig({ acceptScheduledBookings: false }),
      ENTITLED,
    );
    expect(summary.stateLabel).toBe('Not accepting bookings');
  });

  it('says when the platform itself has bookings switched off', () => {
    const summary = summarize(
      makeConfig(),
      entitledWith({ bookingsEnabled: false }),
    );
    expect(summary.stateLabel).toBe('Bookings are off platform-wide');
    expect(summary.isAcceptingBookings).toBe(false);
  });

  it('says so when there is no minimum notice', () => {
    const summary = summarize(
      makeConfig(),
      entitledWith({ leadTimeMinutes: 0 }),
    );
    expect(summary.ruleLines).toContain('No minimum notice');
  });

  it('reports same-day bookings being off rather than a cutoff', () => {
    const summary = summarize(
      makeConfig(),
      entitledWith({ sameDayBookingEnabled: false }),
    );
    expect(summary.ruleLines).toContain('Same-day bookings are off');
  });

  it('renders a whole-week schedule as one line', () => {
    const config = makeConfig();
    week(config).saturday = fullDay();
    week(config).sunday = fullDay();
    expect(summarize(config, ENTITLED).scheduleLines).toEqual([
      'Mon–Sun  8:00 AM – 8:00 PM',
    ]);
  });

  it('describes a split shift on one line', () => {
    const config = makeConfig();
    week(config).monday = fullDay({
      windows: [
        { start: '08:00', end: '12:00' },
        { start: '14:00', end: '20:00' },
      ],
    });
    expect(summarize(config, ENTITLED).scheduleLines[0]).toBe(
      'Mon  8:00 AM – 12:00 PM, 2:00 PM – 8:00 PM',
    );
  });
});

describe('dayFulfillmentOf — legacy single-toggle documents', () => {
  it('gives both provider legs the retired pickupAndDelivery value', () => {
    // A config written before the legs were split. Both must stay ON, or a
    // provider silently loses pickup and delivery the day this ships.
    expect(dayFulfillmentOf({ pickupAndDelivery: true })).toMatchObject({
      providerPickup: true,
      providerDelivery: true,
    });
    expect(dayFulfillmentOf({ pickupAndDelivery: false })).toMatchObject({
      providerPickup: false,
      providerDelivery: false,
    });
  });

  it('prefers the split fields when both are present', () => {
    // Post-migration documents may still carry the legacy key; the explicit
    // per-leg values win so an edit made after the split is never undone.
    expect(
      dayFulfillmentOf({
        pickupAndDelivery: true,
        providerPickup: true,
        providerDelivery: false,
      }),
    ).toMatchObject({ providerPickup: true, providerDelivery: false });
  });

  it('defaults an absent block to everything offered', () => {
    expect(dayFulfillmentOf(undefined)).toMatchObject({
      providerPickup: true,
      providerDelivery: true,
      customerDropoff: true,
      customerPickup: true,
    });
  });

  it('does not confuse the customer-performed legs with the provider ones', () => {
    expect(
      dayFulfillmentOf({
        pickupAndDelivery: false,
        customerDropoff: true,
        customerPickup: true,
      }),
    ).toMatchObject({
      providerPickup: false,
      providerDelivery: false,
      customerDropoff: true,
      customerPickup: true,
    });
  });
});

// ---------------------------------------------------------------------------
// weeklyFromOperatingHours — a washer owns her hours; the engine reads `weekly`.
// This projection is what keeps those from becoming two sources of truth.
// ---------------------------------------------------------------------------

const openDay = (open: string, close: string) => ({
  isOpen: true,
  is24Hours: false,
  timeSlots: [{ open, close }],
});

const fullWeek = (day: unknown) =>
  ({
    monday: day,
    tuesday: day,
    wednesday: day,
    thursday: day,
    friday: day,
    saturday: day,
    sunday: day,
  }) as never;

describe('weeklyFromOperatingHours', () => {
  it('maps isOpen/timeSlots onto isAcceptingBookings/windows', () => {
    const weekly = weeklyFromOperatingHours(
      fullWeek(openDay('09:00', '17:00')),
    );
    expect(weekly.monday.isAcceptingBookings).toBe(true);
    expect(weekly.monday.windows).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('closes a day that is marked closed', () => {
    const weekly = weeklyFromOperatingHours(
      fullWeek({ isOpen: false, is24Hours: false, timeSlots: [] }),
    );
    expect(weekly.monday.isAcceptingBookings).toBe(false);
    expect(weekly.monday.windows).toEqual([]);
  });

  // THE regression guard. parseHHMM returns NaN past hour 23 and
  // normalizeWindows silently drops NaN windows, so encoding "24 hours" as
  // 24:00 would make a 24-hour washer UNBOOKABLE — the exact opposite of what
  // she asked for, with no error anywhere. Slots are gone, but the window is
  // still what the day-level lead-time check measures from, so a dropped
  // window would still cost her the day.
  it('turns is24Hours into a window that survives normalization', () => {
    const weekly = weeklyFromOperatingHours(
      fullWeek({ isOpen: true, is24Hours: true, timeSlots: [] }),
    );
    expect(weekly.monday.windows).toEqual([{ start: '00:00', end: '23:59' }]);
    expect(normalizeWindows(weekly.monday.windows)).toHaveLength(1);
  });

  it('leaves capacity null so the entitlement chain still decides it', () => {
    const weekly = weeklyFromOperatingHours(
      fullWeek(openDay('09:00', '17:00')),
    );
    expect(weekly.monday.dailyBookingLimit).toBeNull();
  });

  // The washer UI does not expose pickup/dropoff legs. Regenerating fulfillment
  // from defaults on every hours edit would silently wipe an admin's per-mode
  // configuration.
  it('preserves fulfillment from the stored weekday', () => {
    const stored = {
      monday: {
        fulfillment: {
          providerPickup: false,
          providerDelivery: true,
          customerDropoff: false,
          customerPickup: true,
          pickupWindows: [],
          dropoffWindows: [],
        },
      },
    };
    const weekly = weeklyFromOperatingHours(
      fullWeek(openDay('09:00', '17:00')),
      stored,
    );
    expect(weekly.monday.fulfillment.providerPickup).toBe(false);
    expect(weekly.monday.fulfillment.customerDropoff).toBe(false);
    // A day with no stored config still gets the permissive default.
    expect(weekly.tuesday.fulfillment.providerPickup).toBe(true);
  });

  describe('universal-day clamp', () => {
    it('narrows hours to the platform window', () => {
      const weekly = weeklyFromOperatingHours(
        fullWeek(openDay('03:00', '23:00')),
        null,
        fullWeek({
          isOpen: true,
          windows: [{ start: '06:00', end: '22:00' }],
        }),
      );
      expect(weekly.monday.windows).toEqual([{ start: '06:00', end: '22:00' }]);
    });

    it('closes the day when the platform is closed', () => {
      const weekly = weeklyFromOperatingHours(
        fullWeek(openDay('09:00', '17:00')),
        null,
        fullWeek({ isOpen: false, windows: [] }),
      );
      expect(weekly.monday.isAcceptingBookings).toBe(false);
    });

    it('closes the day when her hours fall entirely outside the window', () => {
      const weekly = weeklyFromOperatingHours(
        fullWeek(openDay('01:00', '04:00')),
        null,
        fullWeek({
          isOpen: true,
          windows: [{ start: '06:00', end: '22:00' }],
        }),
      );
      expect(weekly.monday.windows).toEqual([]);
      expect(weekly.monday.isAcceptingBookings).toBe(false);
    });
  });
});

describe('intersectWindows', () => {
  it('returns only the overlap', () => {
    expect(
      intersectWindows(
        [{ start: '08:00', end: '18:00' }],
        [{ start: '10:00', end: '12:00' }],
      ),
    ).toEqual([{ start: '10:00', end: '12:00' }]);
  });

  it('handles several windows on each side', () => {
    expect(
      intersectWindows(
        [
          { start: '08:00', end: '12:00' },
          { start: '14:00', end: '18:00' },
        ],
        [
          { start: '11:00', end: '15:00' },
          { start: '17:00', end: '20:00' },
        ],
      ),
    ).toEqual([
      { start: '11:00', end: '12:00' },
      { start: '14:00', end: '15:00' },
      { start: '17:00', end: '18:00' },
    ]);
  });

  it('returns nothing when they do not overlap', () => {
    expect(
      intersectWindows(
        [{ start: '08:00', end: '10:00' }],
        [{ start: '12:00', end: '14:00' }],
      ),
    ).toEqual([]);
  });
});
