import {
  BookingAvailabilityConfig,
  BookingWindow,
  DayBookingConfig,
  DayFulfillment,
  DEFAULT_WINDOW_CLOSE,
  DEFAULT_WINDOW_OPEN,
} from './schemas/booking-availability-config.schema';
import { EffectiveEntitlement } from '../booking-policy/entitlement.util';
import { BookingDateOverride } from './schemas/booking-date-override.schema';
import { BookingRulesSummary } from './models/booking-availability.models';
import {
  DAY_KEYS,
  DayKey,
  formatHHMM,
  formatHuman,
  parseHHMM,
} from '../common/utils/ph-time.util';

/**
 * Pure resolution: policy entitlement + provider config + date override → the
 * rules in force for one date.
 *
 * Kept free of database access so the admin preview, the customer's real slot
 * list and the create-order gate all run identical logic. A preview computed by
 * a second implementation is a preview that lies.
 *
 * Capacity resolves as min(what the provider asked for, what she is entitled
 * to). She may always throttle herself down; she can never exceed her tier.
 */

/** Every rule in force for one calendar date, inheritance already applied. */
export interface EffectiveDay {
  isAcceptingBookings: boolean;
  windows: BookingWindow[];
  dailyBookingLimit: number;
  fulfillment: DayFulfillment;
  isSpecialDate: boolean;
  specialDateLabel?: string;
}

/**
 * min(requested, entitled), where a null request means "give me everything I'm
 * entitled to" and a null entitlement means there is no platform cap at all
 * (a laundromat). Both null → Infinity, i.e. uncapped.
 */
function capBy(requested: number | null, entitled: number | null): number {
  if (entitled == null) return requested ?? Number.POSITIVE_INFINITY;
  if (requested == null) return entitled;
  return Math.min(requested, entitled);
}

const FALLBACK_FULFILLMENT: DayFulfillment = {
  providerPickup: true,
  providerDelivery: true,
  customerDropoff: true,
  customerPickup: true,
};

/**
 * Reads a day's fulfillment block, tolerating documents written before the
 * provider-performed legs were split apart.
 *
 * Ships migration-free the same way `platformPricingOf` does for washer
 * pricing: an old document has only `pickupAndDelivery`, and both new legs
 * inherit it, so a provider who offered pickup+delivery yesterday still offers
 * both today. `scripts/migrations/migrate-split-fulfillment-legs.ts` normalises
 * the data so this shim can eventually be retired.
 */
export function dayFulfillmentOf(
  fulfillment?: Partial<DayFulfillment> & { pickupAndDelivery?: boolean },
): DayFulfillment {
  if (!fulfillment) return { ...FALLBACK_FULFILLMENT };

  const legacy = fulfillment.pickupAndDelivery;
  return {
    providerPickup: fulfillment.providerPickup ?? legacy ?? true,
    providerDelivery: fulfillment.providerDelivery ?? legacy ?? true,
    customerDropoff: fulfillment.customerDropoff ?? true,
    customerPickup: fulfillment.customerPickup ?? true,
  };
}

/**
 * The intersection of two window lists — the overlapping spans only.
 *
 * Used to clamp a washer's self-chosen hours to the platform's universal
 * window. Both sides are normalized first so the sweep can assume sorted,
 * non-overlapping input.
 */
export function intersectWindows(
  a: BookingWindow[],
  b: BookingWindow[],
): BookingWindow[] {
  const left = normalizeWindows(a).map((w) => ({
    start: parseHHMM(w.start),
    end: parseHHMM(w.end),
  }));
  const right = normalizeWindows(b).map((w) => ({
    start: parseHHMM(w.start),
    end: parseHHMM(w.end),
  }));

  const out: BookingWindow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].start, right[j].start);
    const end = Math.min(left[i].end, right[j].end);
    if (end > start) {
      out.push({ start: formatHHMM(start), end: formatHHMM(end) });
    }
    // Advance whichever window closes first — the other may still overlap the
    // next one along.
    if (left[i].end < right[j].end) i++;
    else j++;
  }
  return out;
}

/** A day in the merchant-style OperatingHours shape. */
export interface OperatingHoursDay {
  isOpen: boolean;
  is24Hours: boolean;
  timeSlots: { open: string; close: string }[];
}
export type OperatingHoursWeek = Partial<Record<DayKey, OperatingHoursDay>>;

/** A day of the platform's universal (outer-bound) week. */
export interface UniversalDayLike {
  isOpen: boolean;
  windows: BookingWindow[];
}

/**
 * Project a washer's own OperatingHours onto the weekly shape the slot engine
 * reads.
 *
 * A washer owns her hours (she edits them exactly like a merchant), but the
 * engine — effectiveDay, the calendar, the create-order gate — is
 * built around `BookingAvailabilityConfig.weekly`. Rather than storing her
 * hours twice, or branching the engine on provider type, her hours are
 * projected into `weekly` at READ time. `WasherProfile.operatingHours` stays
 * the single source of truth, so the schedule a customer can book can never
 * drift from the one she edited — or from the "Open until 8 PM" line discovery
 * renders off the very same field.
 *
 * Three details that each fail silently if got wrong:
 *
 *  - `is24Hours` becomes 00:00–23:59, never 24:00. `parseHHMM` returns NaN for
 *    hours past 23 and `normalizeWindows` drops NaN windows, so "24:00" would
 *    make a 24-hour washer UNBOOKABLE rather than always-bookable.
 *  - Per-day capacity comes out null, so the entitlement chain
 *    (override → weekday → config → policy) still decides it. Hours are not
 *    capacity and must not quietly set it.
 *  - `fulfillment` is copied from the STORED weekday, not regenerated. The
 *    washer UI does not expose pickup/dropoff legs, so rebuilding them from
 *    defaults on every hours edit would silently discard an admin's
 *    per-mode configuration.
 */
export function weeklyFromOperatingHours(
  hours: OperatingHoursWeek,
  storedWeekly?: Partial<Record<DayKey, Partial<DayBookingConfig>>> | null,
  universal?: Partial<Record<DayKey, UniversalDayLike>> | null,
): Record<DayKey, DayBookingConfig> {
  const out = {} as Record<DayKey, DayBookingConfig>;

  for (const dayKey of DAY_KEYS) {
    const day = hours?.[dayKey];
    const stored = storedWeekly?.[dayKey];
    const bound = universal?.[dayKey];

    let windows: BookingWindow[] = day?.is24Hours
      ? [{ start: '00:00', end: '23:59' }]
      : normalizeWindows(
          (day?.timeSlots ?? []).map((s) => ({
            start: s.open,
            end: s.close,
          })),
        );

    // The platform's universal week is the outer bound a provider may open
    // within. It was previously enforced nowhere, which was tolerable only
    // while an admin owned every washer's schedule; now that she sets her own,
    // it is the only thing stopping a 3am pickup window. Clamped at read time
    // rather than rejected at write time, matching how every other limit in
    // this module resolves as min(requested, allowed).
    let isOpen = day?.isOpen ?? false;
    if (bound) {
      if (!bound.isOpen) {
        isOpen = false;
        windows = [];
      } else if (bound.windows?.length) {
        windows = intersectWindows(windows, bound.windows);
        if (windows.length === 0) isOpen = false;
      }
    }

    out[dayKey] = {
      isAcceptingBookings: isOpen && windows.length > 0,
      windows,
      dailyBookingLimit: null,
      fulfillment: dayFulfillmentOf(stored?.fulfillment),
    };
  }

  return out;
}

/**
 * Resolution order: date override wins over the weekday, and the weekday's
 * nulls fall back to the config. A missing weekday document (a config written
 * before a day existed, or a partial seed) resolves to the platform default
 * window rather than silently closing the day — a provider who never touched
 * Wednesday should not lose Wednesday.
 */
export function effectiveDay(
  config: BookingAvailabilityConfig,
  dayKey: DayKey,
  entitlement: EffectiveEntitlement,
  override?: BookingDateOverride | null,
): EffectiveDay {
  const day: Partial<DayBookingConfig> = config.weekly?.[dayKey] ?? {};

  const weekdayWindows =
    day.windows && day.windows.length > 0
      ? day.windows
      : [{ start: DEFAULT_WINDOW_OPEN, end: DEFAULT_WINDOW_CLOSE }];

  const overrideWindows =
    override?.windows && override.windows.length > 0 ? override.windows : null;

  // `isAcceptingBookings` from the weekday, unless the override closes the day.
  const openThisDate = override?.isClosed
    ? false
    : (day.isAcceptingBookings ?? true);

  return {
    isAcceptingBookings: openThisDate,
    windows: normalizeWindows(overrideWindows ?? weekdayWindows),
    // Requested ← override, then weekday, then provider-level, then her full
    // entitlement. Capped by the entitlement in every case: a stale per-day
    // number written while she was on a higher tier must not survive a
    // demotion, and a campaign that RAISES her tier lifts every inherited
    // number without touching this document.
    dailyBookingLimit: capBy(
      override?.dailyBookingLimit ??
        day.dailyBookingLimit ??
        config.dailyBookingLimit ??
        null,
      entitlement.dailyCapacity,
    ),
    // Through the shim, so a date override or weekday written before the legs
    // were split still resolves to both legs rather than to `undefined`.
    fulfillment: dayFulfillmentOf(override?.fulfillment ?? day.fulfillment),
    isSpecialDate: Boolean(override),
    specialDateLabel: override?.label ?? undefined,
  };
}

/**
 * Sorts windows and drops malformed or zero-length ones. Overlapping windows
 * are merged: two overlapping windows would otherwise emit duplicate slot
 * starts, and a duplicated slot start collides on the slot counter's unique
 * key — one physical slot must have exactly one identity.
 */
export function normalizeWindows(windows: BookingWindow[]): BookingWindow[] {
  const parsed = windows
    .map((w) => ({ start: parseHHMM(w.start), end: parseHHMM(w.end) }))
    .filter((w) => !Number.isNaN(w.start) && !Number.isNaN(w.end))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const w of parsed) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }

  return merged.map((w) => ({
    start: formatHHMM(w.start),
    end: formatHHMM(w.end),
  }));
}

// ── §15 plain-language summary ─────────────────────────────────────────────

const DAY_LABELS: Record<DayKey, string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

/** Mon-first, which is how a provider reads her own week. */
const WEEK_ORDER: DayKey[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function describeDay(
  config: BookingAvailabilityConfig,
  key: DayKey,
  entitlement: EffectiveEntitlement,
): string {
  const day = effectiveDay(config, key, entitlement);
  if (!day.isAcceptingBookings) return 'Closed';
  return day.windows
    .map(
      (w) =>
        `${formatHuman(parseHHMM(w.start))} – ${formatHuman(parseHHMM(w.end))}`,
    )
    .join(', ');
}

/**
 * Collapses consecutive days that read identically into one line ("Mon–Fri
 * 8:00 AM – 8:00 PM"). Seven separate lines for an identical week is what makes
 * a summary unreadable, which defeats the point of having one.
 */
/**
 * The single source of truth for whether a provider is actually accepting
 * NEW bookings right now — every other computation of "is this provider
 * bookable" (discovery's card/profile badge, the eligibility gate) must call
 * this rather than re-deriving its own boolean, which is how the discovery
 * badge and this screen's own summary drifted apart: discovery never
 * consulted `bookingsPaused`/`acceptScheduledBookings` at all, so a washer
 * who paused herself here still showed "Accepting bookings" (green) to
 * customers.
 */
export function isBookingAccepting(
  config: BookingAvailabilityConfig,
  entitlement: EffectiveEntitlement,
): boolean {
  return (
    entitlement.bookingsEnabled &&
    config.acceptScheduledBookings &&
    !config.bookingsPaused
  );
}

export function summarize(
  config: BookingAvailabilityConfig,
  entitlement: EffectiveEntitlement,
): BookingRulesSummary {
  const described = WEEK_ORDER.map((key) => ({
    key,
    text: describeDay(config, key, entitlement),
  }));

  const scheduleLines: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= described.length; i++) {
    const sameAsRun =
      i < described.length && described[i].text === described[runStart].text;
    if (sameAsRun) continue;

    const from = DAY_LABELS[described[runStart].key];
    const to = DAY_LABELS[described[i - 1].key];
    const range = runStart === i - 1 ? from : `${from}–${to}`;
    scheduleLines.push(`${range}  ${described[runStart].text}`);
    runStart = i;
  }

  // Every rule below is the PLATFORM's, resolved for this provider — which is
  // why the summary can say "20 bookings per day" the moment a campaign
  // doubles it, without anything having been written to her record.
  const requested = config.dailyBookingLimit;
  const effectiveDaily =
    entitlement.dailyCapacity == null
      ? requested
      : Math.min(
          requested ?? entitlement.dailyCapacity,
          entitlement.dailyCapacity,
        );
  // A customer picks a DAY, not a time, so there is no interval or per-slot
  // limit left to state. What remains is what a provider can actually act on.
  const ruleLines = [
    effectiveDaily == null
      ? 'No daily limit'
      : `Maximum ${effectiveDaily} ${
          effectiveDaily === 1 ? 'booking' : 'bookings'
        } per day`,
    entitlement.leadTimeMinutes === 0
      ? 'No minimum notice'
      : `Minimum notice: ${describeLeadTime(entitlement.leadTimeMinutes)}`,
    entitlement.sameDayBookingEnabled
      ? `Same-day cutoff: ${formatHuman(parseHHMM(entitlement.sameDayCutoffTime))}`
      : 'Same-day bookings are off',
    entitlement.advanceBookingDays === 0
      ? 'Same-day bookings only'
      : `Customers may book ${entitlement.advanceBookingDays} ${
          entitlement.advanceBookingDays === 1 ? 'day' : 'days'
        } ahead`,
  ];

  const isAccepting = isBookingAccepting(config, entitlement);
  const stateLabel = !entitlement.bookingsEnabled
    ? 'Bookings are off platform-wide'
    : !config.acceptScheduledBookings
      ? 'Not accepting bookings'
      : config.bookingsPaused
        ? 'Bookings paused'
        : 'Accepting bookings';

  return {
    scheduleLines,
    ruleLines,
    stateLabel,
    isAcceptingBookings: isAccepting,
  };
}

export function describeLeadTime(minutes: number): string {
  if (minutes === 0) return 'none';
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes < 1440) {
    const h = minutes / 60;
    const rounded = Number.isInteger(h) ? h : h.toFixed(1);
    return `${rounded} ${h === 1 ? 'hour' : 'hours'}`;
  }
  const d = minutes / 1440;
  const rounded = Number.isInteger(d) ? d : d.toFixed(1);
  return `${rounded} ${d === 1 ? 'day' : 'days'}`;
}

export { DAY_KEYS, WEEK_ORDER };
