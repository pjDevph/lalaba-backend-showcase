import type { Connection } from 'mongoose';

// ---------------------------------------------------------------------------
// Clear per-washer booking capacity REQUESTS.
//
// Capacity used to be provider-writable: `updateMyBookingCapacity` let a washer
// type her own `dailyBookingLimit` / `maxBookingsPerSlot`, at config level and
// per weekday. Those fields have been removed from the provider input — a
// single platform number (BookingPolicy.defaults.dailyCapacity) now governs
// everyone.
//
// The stored values did NOT stop mattering, because the engine still resolves
// capacity as `min(requested, entitled)` (availability-resolution.util capBy).
// So a washer who once set "1 booking per day" stays pinned at 1 forever, with
// no control left in the app to raise it — a support ticket for something she
// can neither see nor explain. Clearing the request restores inheritance.
//
// Scope is deliberately WASHER-only. Merchant branches are untouched: capacity
// is null-entitled for them (uncapped), their admin-set per-branch limits are
// still meaningful, and admins can still set limits on ANY provider through
// `updateBookingAvailability` and on single dates through date overrides — the
// fields stay on the schema.
//
// Idempotency: the filter matches only documents that still carry a non-null
// value, so a second run matches nothing and reports 0.
// ---------------------------------------------------------------------------

export const BOOKING_CONFIGS_COLLECTION = 'booking_availability_configs';

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

/** Config-level and per-weekday capacity fields, as dotted paths. */
export const CAPACITY_PATHS: string[] = [
  'dailyBookingLimit',
  'maxBookingsPerSlot',
  ...WEEKDAYS.flatMap((d) => [
    `weekly.${d}.dailyBookingLimit`,
    `weekly.${d}.maxBookingsPerSlot`,
  ]),
];

export interface ClearWasherCapacityResult {
  matched: number;
  updated: number;
  affected: { id: string; branchId: string }[];
}

export interface ClearWasherCapacityOptions {
  connection: Connection;
  /** false ⇒ dry run: count and list, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

export async function clearWasherCapacityRequests(
  options: ClearWasherCapacityOptions,
): Promise<ClearWasherCapacityResult> {
  const { connection, apply, log } = options;
  const collection = connection.collection(BOOKING_CONFIGS_COLLECTION);

  // Any washer config carrying at least one non-null capacity request.
  const filter = {
    providerType: 'WASHER',
    $or: CAPACITY_PATHS.map((path) => ({ [path]: { $ne: null } })),
  };

  const docs = await collection.find(filter).toArray();
  const affected = docs.map((d) => ({
    id: String(d._id),
    branchId: String(d.branchId),
  }));

  for (const row of affected) {
    log?.(
      `washer config ${row.id} (branch ${row.branchId}): clearing capacity`,
    );
  }

  if (!apply) {
    return { matched: affected.length, updated: 0, affected };
  }

  // $set null rather than $unset: null is what "inherit" means everywhere else
  // in this schema (see DayBookingConfig — null is inherit, never "unlimited"),
  // and an absent field would read the same only by accident.
  const unset = CAPACITY_PATHS.reduce<Record<string, null>>((acc, path) => {
    acc[path] = null;
    return acc;
  }, {});

  const res = await collection.updateMany(filter, { $set: unset });

  return {
    matched: affected.length,
    updated: res.modifiedCount ?? 0,
    affected,
  };
}
