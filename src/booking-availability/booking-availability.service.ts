import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import {
  BookingAvailabilityConfig,
  BookingAvailabilityConfigDocument,
  DEFAULT_WINDOW_CLOSE,
  DEFAULT_WINDOW_OPEN,
  FulfillmentPricing,
} from './schemas/booking-availability-config.schema';
import { DEFAULT_MAX_LEG_FEE_CENTAVOS } from '../online-orders/fulfillment-pricing.util';
import {
  BookingDateOverride,
  BookingDateOverrideDocument,
} from './schemas/booking-date-override.schema';
import {
  BookingBlackout,
  BookingBlackoutDocument,
} from './schemas/booking-blackout.schema';
import {
  BookingSlotCounter,
  BookingSlotCounterDocument,
} from './schemas/booking-slot-counter.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  ProviderType,
} from '../online-orders/schemas/order-status.enum';
import {
  BookingDayAvailability,
  BookingProviderRow,
  BookingRulesSummary,
  UnavailableReason,
  UpcomingSpecialDate,
} from './models/booking-availability.models';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { washerStoreName } from '../washer/washer-name.util';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { BookingPolicyService } from '../booking-policy/booking-policy.service';
import { EffectiveEntitlement } from '../booking-policy/entitlement.util';
import {
  CopyBookingDayInput,
  CreateBookingBlackoutInput,
  ScheduledPickupInput,
  UpdateBookingAvailabilityInput,
  UpdateFulfillmentPricingInput,
  UpdateMyBookingCapacityInput,
  UpsertBookingDateOverrideInput,
} from './dto/booking-availability.input';
import {
  dayFulfillmentOf,
  effectiveDay,
  EffectiveDay,
  normalizeWindows,
  summarize,
  weeklyFromOperatingHours,
  WEEK_ORDER,
} from './availability-resolution.util';
import {
  addDays,
  daysBetween,
  DayKey,
  dayKeyOf,
  dayLabel,
  formatHuman,
  parseHHMM,
  phDayKey,
  phMinutesOfDay,
} from '../common/utils/ph-time.util';

/**
 * A booking occupies its slot from the moment it is created — unlike the
 * ACCEPTANCE cap (online-orders CAP_EXEMPT_STATUSES), which only counts orders
 * a provider has already taken on.
 *
 * The two are answering different questions. Acceptance-cap semantics exist so
 * spam bookings can't lock a washer out of accepting real work. Slot capacity
 * is the opposite problem: if a pending booking did not hold its slot, three
 * customers could each book the 9:00 AM window and the provider would discover
 * the conflict only when deciding. So only orders that ended without ever being
 * fulfillable release their slot back.
 */
const SLOT_RELEASING_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.REJECTED_BY_PROVIDER,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
]);

/** Which handover mode a booking needs, for the §6 per-mode availability check. */
export type RequestedFulfillment = 'pickup' | 'dropoff' | 'self_pickup';

export interface DayBookableResult {
  date: string;
  label: string;
}

@Injectable()
export class BookingAvailabilityService {
  constructor(
    @InjectModel(BookingAvailabilityConfig.name)
    private readonly configModel: Model<BookingAvailabilityConfigDocument>,
    @InjectModel(BookingDateOverride.name)
    private readonly overrideModel: Model<BookingDateOverrideDocument>,
    @InjectModel(BookingBlackout.name)
    private readonly blackoutModel: Model<BookingBlackoutDocument>,
    @InjectModel(BookingSlotCounter.name)
    private readonly counterModel: Model<BookingSlotCounterDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    private readonly policyService: BookingPolicyService,
  ) {}

  /**
   * Every bookable provider, for the admin page's picker.
   *
   * Washers are listed by their branchId anchor and merchant branches by their
   * own id, so every row's `branchId` is directly usable as a config key. A
   * washer's anchor branch is excluded from the merchant list for the same
   * reason it is checked first everywhere else — it is a foreign-key shim, not
   * a laundromat.
   */
  async listProviders(): Promise<BookingProviderRow[]> {
    const [washers, branches] = await Promise.all([
      this.washerModel
        .find()
        .select('branchId displayName storeName maxOrdersPerDay status')
        .exec(),
      this.branchModel.find({ isActive: true }).select('branchName').exec(),
    ]);

    const washerBranchIds = new Set(washers.map((w) => w.branchId));
    const configs = await this.configModel
      .find()
      .select('branchId acceptScheduledBookings bookingsPaused')
      .exec();
    const configByBranch = new Map(configs.map((c) => [c.branchId, c]));

    const stateOf = (branchId: string): { label: string; known: boolean } => {
      const config = configByBranch.get(branchId);
      if (!config) return { label: 'Accepting bookings', known: false };
      if (!config.acceptScheduledBookings) {
        return { label: 'Not accepting bookings', known: true };
      }
      return {
        label: config.bookingsPaused ? 'Bookings paused' : 'Accepting bookings',
        known: true,
      };
    };

    const rows: BookingProviderRow[] = [
      ...washers.map((w) => {
        const state = stateOf(w.branchId);
        return {
          branchId: w.branchId,
          providerType: ProviderType.WASHER,
          // Her shop name, so this picker names providers the same way the
          // merchant rows below do (branchName) and the customer app does.
          name: washerStoreName(w),
          isConfigured: state.known,
          stateLabel: state.label,
          // Null = no cap, which is a decision Admin can see and change from
          // this list (setWasherDailyOrderCap), not an unknown.
          maxOrdersPerDay: w.maxOrdersPerDay ?? null,
          washerStatus: w.status,
        };
      }),
      ...branches
        .filter((b) => !washerBranchIds.has(String(b._id)))
        .map((b) => {
          const state = stateOf(String(b._id));
          return {
            branchId: String(b._id),
            providerType: ProviderType.MERCHANT,
            name: b.branchName,
            isConfigured: state.known,
            stateLabel: state.label,
          };
        }),
    ];

    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Config CRUD ──────────────────────────────────────────────────────────

  /**
   * Every provider is treated as configured. A provider with no document yet
   * gets the platform defaults (8 AM–8 PM, 7 days, 30-minute slots, 20/day)
   * rather than "no availability" — an unconfigured washer must not silently
   * become unbookable the moment scheduling ships.
   */
  async getOrCreateConfig(
    branchId: string,
    providerType: ProviderType,
  ): Promise<BookingAvailabilityConfigDocument> {
    const existing = await this.configModel.findOne({ branchId }).exec();
    if (existing) return existing;

    return this.configModel.create({
      branchId,
      providerType,
      weekly: this.defaultWeek(),
    } as never);
  }

  /** Read-only variant for hot paths that must not write on a GET. */
  async findConfig(
    branchId: string,
  ): Promise<BookingAvailabilityConfigDocument | null> {
    return this.configModel.findOne({ branchId }).exec();
  }

  /**
   * The config as the slot engine should see it.
   *
   * For a WASHER, `weekly` is replaced by a projection of her own
   * `WasherProfile.operatingHours` — she edits her hours exactly like a
   * merchant, and those hours are the single source of truth. Storing them in
   * two places instead would let an admin edit of `weekly`, or the
   * "Open until 8 PM" string discovery renders off `operatingHours`, silently
   * disagree with the times a customer can actually book.
   *
   * Everything downstream — effectiveDay, resolveDay, the
   * calendar, assertSlotBookable — is untouched. Only the VALUE of `weekly`
   * changes, in this one place.
   *
   * A washer who has never set hours falls through to her stored `weekly`,
   * which is what makes the backfill optional rather than a prerequisite:
   * nothing breaks before it runs.
   */
  private async resolvedConfig(
    config: BookingAvailabilityConfig | BookingAvailabilityConfigDocument,
  ): Promise<BookingAvailabilityConfig> {
    if (config.providerType !== ProviderType.WASHER) return config;

    const washer = await this.washerModel
      .findOne({ branchId: config.branchId })
      .select('operatingHours')
      .exec();
    const hours = washer?.operatingHours;
    if (!hours) return config;

    const policy = await this.policyService.current();
    const projected = weeklyFromOperatingHours(
      hours,
      config.weekly,
      policy.universalDays,
    );

    // A plain object, never a mutated document: this projection is a read-time
    // view, and saving it would recreate the duplicate source of truth the
    // whole approach exists to avoid.
    const plain =
      typeof (config as BookingAvailabilityConfigDocument).toObject ===
      'function'
        ? (config as BookingAvailabilityConfigDocument).toObject()
        : { ...config };

    return { ...plain, weekly: projected } as BookingAvailabilityConfig;
  }

  private defaultWeek(): Record<string, unknown> {
    const day = {
      isAcceptingBookings: true,
      windows: [{ start: DEFAULT_WINDOW_OPEN, end: DEFAULT_WINDOW_CLOSE }],
      fulfillment: {
        providerPickup: true,
        providerDelivery: true,
        customerDropoff: true,
        customerPickup: true,
        pickupWindows: [],
        dropoffWindows: [],
      },
    };
    return WEEK_ORDER.reduce<Record<string, unknown>>(
      (acc, key) => ({ ...acc, [key]: { ...day } }),
      {},
    );
  }

  /** Admin write — the full config. */
  async updateConfig(
    branchId: string,
    providerType: ProviderType,
    input: UpdateBookingAvailabilityInput,
    actorUid: string,
  ): Promise<BookingAvailabilityConfigDocument> {
    const config = await this.getOrCreateConfig(branchId, providerType);

    if (input.weekly) {
      for (const key of WEEK_ORDER) {
        const day = input.weekly[key];
        if (day.isAcceptingBookings && day.windows.length === 0) {
          throw new BadRequestException(
            `${titleCase(key)} accepts bookings but has no time window. Add a window or close the day.`,
          );
        }
        for (const w of day.windows) {
          if (parseHHMM(w.end) <= parseHHMM(w.start)) {
            throw new BadRequestException(
              `${titleCase(key)}: the closing time must be after the opening time.`,
            );
          }
        }
      }
    }

    const patch: Record<string, unknown> = { ...input, updatedBy: actorUid };
    // A pause timestamp is only meaningful while paused; clearing it on resume
    // keeps "paused since" honest instead of showing the previous pause.
    if (input.bookingsPaused === true && !config.bookingsPaused) {
      patch.pausedAt = new Date();
    } else if (input.bookingsPaused === false) {
      patch.pausedAt = null;
      patch.pauseReason = null;
    }

    const updated = await this.configModel
      .findOneAndUpdate({ branchId }, { $set: patch }, { new: true })
      .exec();
    if (!updated)
      throw new NotFoundException('Booking configuration not found');
    return updated;
  }

  /**
   * Provider write — capacity and the pause switch only. Values above the
   * admin ceiling are rejected rather than silently clamped: a washer who types
   * 50 and is quietly saved at 40 will believe she can take 50.
   */
  async updateOwnCapacity(
    branchId: string,
    providerType: ProviderType,
    input: UpdateMyBookingCapacityInput,
  ): Promise<BookingAvailabilityConfigDocument> {
    // No entitlement ceiling check any more: capacity left this input entirely
    // (see UpdateMyBookingCapacityInput), so there is no provider-supplied
    // number left to clamp. Capacity is resolved from the platform policy on
    // every read instead, which is also why a stale value can no longer pin a
    // washer below her tier.
    const config = await this.getOrCreateConfig(branchId, providerType);
    const patch: Record<string, unknown> = { ...input };
    if (input.bookingsPaused === true && !config.bookingsPaused) {
      patch.pausedAt = new Date();
    } else if (input.bookingsPaused === false) {
      patch.pausedAt = null;
      patch.pauseReason = null;
    }

    const updated = await this.configModel
      .findOneAndUpdate({ branchId }, { $set: patch }, { new: true })
      .exec();
    if (!updated)
      throw new NotFoundException('Booking configuration not found');
    return updated;
  }

  /** §2 "Copy to other days". */
  async copyDay(
    branchId: string,
    providerType: ProviderType,
    input: CopyBookingDayInput,
  ): Promise<BookingAvailabilityConfigDocument> {
    const config = await this.getOrCreateConfig(branchId, providerType);
    const source = config.weekly?.[input.fromDay as DayKey];
    if (!source) {
      throw new BadRequestException(`No configuration for ${input.fromDay}.`);
    }

    const targets = input.toDays.filter((d) => d !== input.fromDay);
    if (targets.length === 0) {
      throw new BadRequestException('Pick at least one other day to copy to.');
    }

    const patch: Record<string, unknown> = {};
    for (const day of targets) {
      // Plain object, not the mongoose subdoc — assigning the live subdoc to
      // seven keys would share one instance across all of them.
      patch[`weekly.${day}`] = JSON.parse(JSON.stringify(source));
    }

    const updated = await this.configModel
      .findOneAndUpdate({ branchId }, { $set: patch }, { new: true })
      .exec();
    if (!updated)
      throw new NotFoundException('Booking configuration not found');
    return updated;
  }

  // ── Date overrides (§11) ─────────────────────────────────────────────────

  async upsertOverride(
    branchId: string,
    input: UpsertBookingDateOverrideInput,
    actorUid: string,
  ): Promise<BookingDateOverrideDocument> {
    assertRealDate(input.date);

    if (!input.isClosed && input.windows && input.windows.length > 0) {
      for (const w of input.windows) {
        if (parseHHMM(w.end) <= parseHHMM(w.start)) {
          throw new BadRequestException(
            'The closing time must be after the opening time.',
          );
        }
      }
    }

    const updated = await this.overrideModel
      .findOneAndUpdate(
        { branchId, date: input.date },
        { $set: { ...input, branchId, updatedBy: actorUid } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .exec();
    return updated;
  }

  async removeOverride(branchId: string, date: string): Promise<boolean> {
    const res = await this.overrideModel.deleteOne({ branchId, date }).exec();
    return res.deletedCount > 0;
  }

  async listOverrides(
    branchId: string,
    fromDate?: string,
  ): Promise<BookingDateOverrideDocument[]> {
    const from = fromDate ?? phDayKey();
    return this.overrideModel
      .find({ branchId, date: { $gte: from } })
      .sort({ date: 1 })
      .exec();
  }

  // ── Blackouts (§12) ──────────────────────────────────────────────────────

  async createBlackout(
    branchId: string,
    input: CreateBookingBlackoutInput,
    actorUid: string,
  ): Promise<BookingBlackoutDocument> {
    assertRealDate(input.startDate);
    assertRealDate(input.endDate);
    if (daysBetween(input.startDate, input.endDate) < 0) {
      throw new BadRequestException(
        'The last blocked date cannot be before the first.',
      );
    }
    return this.blackoutModel.create({
      ...input,
      branchId,
      createdBy: actorUid,
    });
  }

  async removeBlackout(branchId: string, id: string): Promise<boolean> {
    const res = await this.blackoutModel
      .deleteOne({ _id: id, branchId } as never)
      .exec();
    return res.deletedCount > 0;
  }

  async listBlackouts(
    branchId: string,
    fromDate?: string,
  ): Promise<BookingBlackoutDocument[]> {
    const from = fromDate ?? phDayKey();
    // Filtered on endDate so a range already in progress still shows.
    return this.blackoutModel
      .find({ branchId, endDate: { $gte: from } })
      .sort({ startDate: 1 })
      .exec();
  }

  /** §11 + §12 merged into the one list the UI renders. */
  async upcomingSpecialDates(branchId: string): Promise<UpcomingSpecialDate[]> {
    const [overrides, blackouts] = await Promise.all([
      this.listOverrides(branchId),
      this.listBlackouts(branchId),
    ]);

    const fromOverrides: UpcomingSpecialDate[] = overrides.map((o) => ({
      date: o.date,
      label: o.label ?? undefined,
      isClosed: o.isClosed,
      kind: o.isClosed
        ? 'Closed'
        : o.windows.length > 0
          ? 'Special schedule'
          : 'Reduced capacity',
      detail: describeOverride(o),
      source: 'override',
      recordId: String(o._id),
    }));

    const fromBlackouts: UpcomingSpecialDate[] = blackouts.map((b) => ({
      date: b.startDate,
      label: b.reason ?? undefined,
      isClosed: true,
      kind: 'Closed',
      detail:
        b.startDate === b.endDate ? 'Blocked' : `Blocked through ${b.endDate}`,
      source: 'blackout',
      recordId: String(b._id),
    }));

    return [...fromOverrides, ...fromBlackouts].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  // ── Resolution / availability reads ──────────────────────────────────────

  async summary(
    config: BookingAvailabilityConfig,
  ): Promise<BookingRulesSummary> {
    const entitlement = await this.policyService.entitlementFor(
      config.branchId,
      config.providerType,
    );
    // Projected too, so the schedule lines describe the hours a washer actually
    // set rather than the stale `weekly` behind them.
    return summarize(await this.resolvedConfig(config), entitlement);
  }

  /**
   * §14 — the customer-facing availability calendar. The admin preview, the
   * partner app preview and the customer's own date picker all call this, so
   * "what customers see" is generated by the code that decides what customers
   * get.
   */
  async calendar(
    branchId: string,
    providerType: ProviderType,
    fromDate?: string,
    days?: number,
  ): Promise<BookingDayAvailability[]> {
    const config = await this.resolvedConfig(
      await this.getOrCreateConfig(branchId, providerType),
    );
    const start = fromDate ?? phDayKey();
    assertRealDate(start);

    // One entitlement for the whole span. Campaigns are date-scoped, so this is
    // resolved for the FIRST date rendered; a campaign starting mid-span is
    // reflected the next time the calendar is opened, which is acceptable for a
    // preview and is re-checked exactly at booking time anyway.
    const entitlement = await this.policyService.entitlementFor(
      branchId,
      providerType,
      start,
    );

    // Never render past the advance window — offering a date the create path
    // will refuse is the exact mistake the preview exists to prevent.
    const span = Math.min(
      days ?? entitlement.advanceBookingDays + 1,
      entitlement.advanceBookingDays + 1,
      90,
    );
    const dates = Array.from({ length: Math.max(1, span) }, (_, i) =>
      addDays(start, i),
    );

    const [overrides, blackouts, dayCounts] = await Promise.all([
      this.overrideModel.find({ branchId, date: { $in: dates } }).exec(),
      this.blackoutModel.find({ branchId, endDate: { $gte: dates[0] } }).exec(),
      this.countByDate(branchId, dates),
    ]);

    const overrideByDate = new Map(overrides.map((o) => [o.date, o]));

    return dates.map((date) =>
      this.resolveDay({
        config,
        entitlement,
        date,
        override: overrideByDate.get(date) ?? null,
        blackouts,
        dayBooked: dayCounts.get(date) ?? 0,
      }),
    );
  }

  async dayAvailability(
    branchId: string,
    providerType: ProviderType,
    date: string,
  ): Promise<BookingDayAvailability> {
    const [day] = await this.calendar(branchId, providerType, date, 1);
    return day;
  }

  /**
   * The single source of truth for "can this be booked". Returns the resolved
   * day so callers render exactly what was decided.
   */
  private resolveDay(args: {
    // Plain config, not the document: callers pass the output of
    // resolvedConfig(), which projects a washer's own operating hours into
    // `weekly` and is therefore a read-time view rather than a live document.
    config: BookingAvailabilityConfig;
    entitlement: EffectiveEntitlement;
    date: string;
    override: BookingDateOverrideDocument | null;
    blackouts: BookingBlackoutDocument[];
    dayBooked: number;
    now?: number;
  }): BookingDayAvailability {
    const { config, entitlement, date, override, blackouts, dayBooked } = args;
    const now = args.now ?? Date.now();
    const today = phDayKey(now);
    const nowMinutes = phMinutesOfDay(now);

    const dayKey = dayKeyOf(date);
    const day = effectiveDay(config, dayKey, entitlement, override);
    const blackout = blackouts.find(
      (b) => b.startDate <= date && date <= b.endDate,
    );

    const dayReason = this.dayUnavailableReason({
      config,
      entitlement,
      date,
      today,
      nowMinutes,
      day,
      blackout: Boolean(blackout),
      dayBooked,
    });

    const remaining = Math.max(0, day.dailyBookingLimit - dayBooked);
    // An uncapped provider resolves to Number.POSITIVE_INFINITY, which is
    // useful for `remaining > 0` above and impossible to serialize as a
    // GraphQL Int — it threw, so every caller got an error instead of a
    // calendar. Infinity stays internal; null crosses the boundary meaning
    // "unlimited".
    const asLimit = (n: number): number | null =>
      Number.isFinite(n) ? n : null;
    return {
      date,
      dayOfWeek: dayKey,
      isBookable: dayReason == null && remaining > 0,
      unavailableReason: dayReason ?? undefined,
      windows: day.windows,
      dailyBookingLimit: asLimit(day.dailyBookingLimit),
      bookedCount: dayBooked,
      remaining: asLimit(remaining),
      isSpecialDate: day.isSpecialDate || Boolean(blackout),
      specialDateLabel: day.specialDateLabel ?? blackout?.reason ?? undefined,
      providerPickupAvailable: day.fulfillment.providerPickup,
      providerDeliveryAvailable: day.fulfillment.providerDelivery,
      customerDropoffAvailable: day.fulfillment.customerDropoff,
      customerPickupAvailable: day.fulfillment.customerPickup,
    };
  }

  /** Day-level gates, most decisive first. */
  private dayUnavailableReason(args: {
    // See resolveDay — a projected view, not a live document.
    config: BookingAvailabilityConfig;
    entitlement: EffectiveEntitlement;
    date: string;
    today: string;
    nowMinutes: number;
    day: EffectiveDay;
    blackout: boolean;
    dayBooked: number;
  }): UnavailableReason | null {
    const {
      config,
      entitlement,
      date,
      today,
      nowMinutes,
      day,
      blackout,
      dayBooked,
    } = args;

    // The platform master switch outranks every provider setting.
    if (!entitlement.bookingsEnabled) {
      return UnavailableReason.BOOKINGS_DISABLED;
    }
    if (!config.acceptScheduledBookings) {
      return UnavailableReason.BOOKINGS_DISABLED;
    }
    if (config.bookingsPaused) return UnavailableReason.BOOKINGS_PAUSED;

    const offset = daysBetween(today, date);
    if (offset < 0) return UnavailableReason.IN_THE_PAST;
    if (offset > entitlement.advanceBookingDays) {
      return UnavailableReason.BEYOND_ADVANCE_WINDOW;
    }

    if (blackout) return UnavailableReason.BLACKED_OUT;
    if (!day.isAcceptingBookings) return UnavailableReason.CLOSED_THIS_DAY;

    // Same-day rules apply only to today, and are separate from the day being
    // open: a shop open until 9 PM can still stop taking same-day work at 4.
    if (offset === 0) {
      if (!entitlement.sameDayBookingEnabled) {
        return UnavailableReason.PAST_CUTOFF;
      }
      const cutoff = parseHHMM(entitlement.sameDayCutoffTime);
      if (!Number.isNaN(cutoff) && nowMinutes >= cutoff) {
        return UnavailableReason.PAST_CUTOFF;
      }
    }

    if (dayBooked >= day.dailyBookingLimit) {
      return UnavailableReason.DAY_FULLY_BOOKED;
    }

    // Lead time is measured from the earliest moment the provider could still
    // START on this day, and must fit before they close.
    //
    // It used to be measured against the day's FIRST window, which is right for
    // a future day and nonsense for today: a shop opening at 08:00 with two
    // hours' notice became unbookable for the same day at 06:00, before anyone
    // was awake. Both `sameDayBookingEnabled` and `sameDayCutoffTime` were
    // decorative for any ordinary opening hour, because the day was already
    // gone before either could apply.
    //
    // `max(opening, now)` is the fix and it needs no special case for today:
    //   • a future day — now is far in the past, so this is the opening, and
    //     the old behaviour is preserved exactly;
    //   • today, already open — this is now, so the question becomes "is there
    //     still time before closing", which is the real one;
    //   • today, before opening — this is the opening, so an early-morning
    //     booking for later the same day still works.
    //
    // The closing bound is what the previous comment was protecting: it still
    // refuses a booking five minutes before the shutters come down, because
    // now + leadTime would land after closing.
    const dayStart = day.windows.length ? parseHHMM(day.windows[0].start) : NaN;
    const dayEnd = day.windows.length
      ? parseHHMM(day.windows[day.windows.length - 1].end)
      : NaN;
    if (!Number.isNaN(dayStart) && !Number.isNaN(dayEnd)) {
      const dayOffsetMinutes = daysBetween(today, date) * 1440;
      const minutesUntilOpen = dayOffsetMinutes + dayStart - nowMinutes;
      const minutesUntilClose = dayOffsetMinutes + dayEnd - nowMinutes;

      // Already closed for this day — nothing can start, never mind finish.
      if (minutesUntilClose <= 0) return UnavailableReason.IN_THE_PAST;

      // The earliest the provider could actually collect: not before they
      // open, and not sooner than the notice they require. That moment has to
      // land before they close.
      //
      // Note this is max(opening, now + leadTime) — NOT opening + leadTime.
      // The notice is a wait from now; it is not a duration that has to fit
      // inside the working day, which would reject a next-week booking for any
      // provider whose notice period exceeds their opening hours.
      const earliestCollection = Math.max(
        minutesUntilOpen,
        entitlement.leadTimeMinutes,
      );
      if (earliestCollection > minutesUntilClose) {
        return UnavailableReason.INSUFFICIENT_NOTICE;
      }
    }

    return null;
  }

  // ── Booking-time enforcement ─────────────────────────────────────────────

  /**
   * Called by createOrder. Throws a customer-readable BadRequestException when
   * the requested window is not bookable, and returns the snapshot to store.
   *
   * Runs INSIDE the create transaction when a session is supplied so the
   * capacity read and the counter write are one atomic unit.
   */
  async assertDayBookable(
    branchId: string,
    providerType: ProviderType,
    requested: ScheduledPickupInput,
    fulfillment: RequestedFulfillment,
    session?: ClientSession,
  ): Promise<DayBookableResult> {
    assertRealDate(requested.date);

    const config = await this.resolvedConfig(
      await this.getOrCreateConfig(branchId, providerType),
    );
    // Resolved for the REQUESTED date, so a campaign that only covers next week
    // grants its extra capacity exactly on those dates.
    const entitlement = await this.policyService.entitlementFor(
      branchId,
      providerType,
      requested.date,
    );
    // Sequential, NOT Promise.all. These four reads carry the caller's
    // ClientSession, and a session cannot run concurrent operations: the driver
    // stamps them all with the same txnNumber, and a replica set rejects the
    // second one to start a transaction at an already-active number with
    // "Only servers in a sharded cluster can start a new transaction at the
    // active transaction number". A mongos tolerates it, which is why the error
    // reads the way it does. Parallelising these would break every scheduled
    // booking — the win isn't worth it for four indexed lookups.
    const override = await this.overrideModel
      .findOne({ branchId, date: requested.date })
      .session(session ?? null)
      .exec();
    const blackouts = await this.blackoutModel
      .find({ branchId, endDate: { $gte: requested.date } })
      .session(session ?? null)
      .exec();
    const dayCounts = await this.countByDate(
      branchId,
      [requested.date],
      session,
    );

    const day = this.resolveDay({
      config,
      entitlement,
      date: requested.date,
      override,
      blackouts,
      dayBooked: dayCounts.get(requested.date) ?? 0,
    });

    if (day.unavailableReason) {
      throw new BadRequestException(
        explain(day.unavailableReason, entitlement),
      );
    }

    // §6 — the mode has to be offered on this specific date. Each leg is checked
    // against its own flag: a merchant who collects but does not deliver offers
    // 'pickup' and 'self_pickup' while refusing the outbound leg.
    const modeAvailable =
      fulfillment === 'pickup'
        ? day.providerPickupAvailable
        : fulfillment === 'dropoff'
          ? day.customerDropoffAvailable
          : day.customerPickupAvailable;
    if (!modeAvailable) {
      throw new BadRequestException(
        'This provider does not offer that handover option on the date you picked.',
      );
    }

    // null = unlimited, so only a real number can be exhausted.
    if (day.remaining != null && day.remaining <= 0) {
      throw new BadRequestException(
        explain(UnavailableReason.DAY_FULLY_BOOKED, entitlement),
      );
    }

    // Serialize concurrent bookings for this DATE. The counter, not the count,
    // is what makes this safe: two customers racing for the last place in the
    // day both $inc the same document, so one write-conflicts and is retried by
    // the transaction rather than both reading "4 of 5 booked" and committing.
    await this.counterModel
      .findOneAndUpdate(
        { branchId, date: requested.date },
        { $inc: { bookedCount: 1 } },
        { upsert: true, new: true, session: session ?? null },
      )
      .exec();

    return { date: requested.date, label: dayLabel(requested.date) };
  }

  /**
   * A provider sets their own pickup/delivery fees.
   *
   * Stores the raw request, unclamped, exactly as `dailyBookingLimit` does. The
   * ceiling is applied when an order is priced, so raising the platform limit
   * later restores a provider's original intent rather than leaving them stuck
   * at a value that was clamped on the day they saved it.
   */
  async updateFulfillmentPricing(
    branchId: string,
    providerType: ProviderType,
    input: UpdateFulfillmentPricingInput,
  ): Promise<BookingAvailabilityConfigDocument> {
    const config = await this.getOrCreateConfig(branchId, providerType);
    const set: Record<string, number | boolean | null> = {};

    for (const leg of ['providerPickup', 'providerDelivery'] as const) {
      const requested = input[leg];
      if (!requested) continue;
      if (requested.feeCentavos !== undefined) {
        set[`fulfillmentPricing.${leg}.feeCentavos`] = requested.feeCentavos;
      }
      if (requested.premiumWindowFeeCentavos !== undefined) {
        set[`fulfillmentPricing.${leg}.premiumWindowFeeCentavos`] =
          requested.premiumWindowFeeCentavos;
      }
    }

    if (input.express) {
      for (const key of ['enabled', 'feeCentavos', 'slaHours'] as const) {
        const value = input.express[key];
        if (value !== undefined) {
          set[`fulfillmentPricing.express.${key}`] = value;
        }
      }
    }

    if (Object.keys(set).length === 0) return config;

    const updated = await this.configModel
      .findOneAndUpdate({ branchId }, { $set: set }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Booking availability not found');
    return updated;
  }

  /**
   * A provider's per-leg fee request plus the platform ceiling it is bounded by.
   *
   * One method so quote and create resolve pricing identically — the quoted
   * total equalling the charged total is the invariant money-integrity exists
   * to protect. Uses `findConfig` rather than `getOrCreateConfig` so a quote
   * (a read) never writes a config document; an absent config falls through to
   * the util's defaults.
   */
  async fulfillmentPricingFor(branchId: string): Promise<{
    config: FulfillmentPricing | null;
    ceilingCentavos: number;
  }> {
    const config = await this.findConfig(branchId);
    const policy = await this.policyService.current();
    return {
      config: config?.fulfillmentPricing ?? null,
      ceilingCentavos:
        policy?.safetyLimits?.maxLegFeeCentavos ?? DEFAULT_MAX_LEG_FEE_CENTAVOS,
    };
  }

  /**
   * Does this provider perform the outbound leg on ANY day of the week?
   *
   * A capability question, not a scheduling one: unlike the inbound leg, the
   * return window is not chosen at booking time (§11 — only the pickup is
   * scheduled), so there is no date to check it against. Without this a
   * merchant who has switched delivery off every day would still be handed
   * `PROVIDER_DELIVERY` orders and discover at `markLaundryReady` that she has
   * no way to fulfil them.
   */
  async offersProviderDelivery(
    branchId: string,
    providerType: ProviderType,
  ): Promise<boolean> {
    const config = await this.getOrCreateConfig(branchId, providerType);
    return WEEK_ORDER.some(
      (dayKey) =>
        dayFulfillmentOf(config.weekly?.[dayKey]?.fulfillment).providerDelivery,
    );
  }

  // ── Counting ─────────────────────────────────────────────────────────────

  private bookedFilter(branchId: string, dates: string[]) {
    return {
      'provider.branchId': branchId,
      'fulfillment.scheduledPickup.date': { $in: dates },
      status: { $nin: Array.from(SLOT_RELEASING_STATUSES) },
    };
  }

  /**
   * How many orders already occupy this provider's given date.
   *
   * Public because discovery needs the same number the booking gate uses — a
   * card that advertises room the create path will refuse is worse than no
   * number at all.
   */
  async bookedCountForDate(branchId: string, date: string): Promise<number> {
    const counts = await this.countByDate(branchId, [date]);
    return counts.get(date) ?? 0;
  }

  private async countByDate(
    branchId: string,
    dates: string[],
    session?: ClientSession,
  ): Promise<Map<string, number>> {
    const rows = await this.orderModel
      .aggregate<{ _id: string; count: number }>([
        { $match: this.bookedFilter(branchId, dates) },
        {
          $group: {
            _id: '$fulfillment.scheduledPickup.date',
            count: { $sum: 1 },
          },
        },
      ])
      .session(session ?? null)
      .exec();
    return new Map(rows.map((r) => [r._id, r.count]));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Rejects '2026-02-31' and friends. The regex on the DTO only proves the shape;
 * Date.parse of an impossible day rolls it silently into the next month, which
 * would store a booking on a date the customer never chose.
 */
function assertRealDate(date: string): void {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new BadRequestException(`${date} is not a real calendar date.`);
  }
}

function describeOverride(o: BookingDateOverride): string {
  if (o.isClosed) return 'Closed';
  const parts: string[] = [];
  if (o.windows.length > 0) {
    parts.push(
      o.windows
        .map(
          (w) =>
            `${formatHuman(parseHHMM(w.start))} – ${formatHuman(parseHHMM(w.end))}`,
        )
        .join(', '),
    );
  }
  if (o.dailyBookingLimit != null) {
    parts.push(`Max ${o.dailyBookingLimit} bookings`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Special schedule';
}

/** Customer-readable wording for a refusal. */
function explain(
  reason: UnavailableReason,
  entitlement: EffectiveEntitlement,
): string {
  switch (reason) {
    case UnavailableReason.BOOKINGS_DISABLED:
      return 'This provider is not taking scheduled bookings right now.';
    case UnavailableReason.BOOKINGS_PAUSED:
      return 'This provider has paused new bookings.';
    case UnavailableReason.CLOSED_THIS_DAY:
      return 'This provider does not accept bookings on that day.';
    case UnavailableReason.BLACKED_OUT:
      return 'This provider is unavailable on that date.';
    case UnavailableReason.DAY_FULLY_BOOKED:
      return 'That date is fully booked. Please pick another day.';
    case UnavailableReason.PAST_CUTOFF:
      return entitlement.sameDayBookingEnabled
        ? `Same-day bookings close at ${formatHuman(parseHHMM(entitlement.sameDayCutoffTime))}. Please pick a later date.`
        : 'This provider does not accept same-day bookings.';
    case UnavailableReason.INSUFFICIENT_NOTICE:
      return `This provider needs at least ${describeNotice(entitlement.leadTimeMinutes)} notice. Please pick a later time.`;
    case UnavailableReason.BEYOND_ADVANCE_WINDOW:
      return `You can book up to ${entitlement.advanceBookingDays} days ahead.`;
    case UnavailableReason.IN_THE_PAST:
      return 'That pickup time has already passed.';
    case UnavailableReason.FULFILLMENT_UNAVAILABLE:
      return 'That handover option is not available on the date you picked.';
    default:
      return 'That pickup time is not available.';
  }
}

function describeNotice(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} ${d === 1 ? 'day' : 'days'}`;
  }
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}
