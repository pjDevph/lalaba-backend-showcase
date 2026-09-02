import type { Connection } from 'mongoose';

// ---------------------------------------------------------------------------
// The two provider-performed fulfillment legs used to share a single
// `weekly.<day>.fulfillment.pickupAndDelivery` boolean, which made a merchant's
// real offerings inexpressible — "rider collects, customer collects it back"
// needs the inbound leg on and the outbound leg off. The field is now split:
//
//   weekly.<day>.fulfillment.pickupAndDelivery → providerPickup + providerDelivery
//
// Both legs inherit the legacy value, so a provider who offered pickup AND
// delivery yesterday still offers both today. Nothing is turned off by this.
//
// `dayFulfillmentOf()` in availability-resolution.util.ts already applies the
// same fallback at read time, so the application behaves correctly with or
// without this migration. Running it lets that shim eventually be retired, and
// makes the stored documents match what the partner app now edits.
//
// Also covers `booking_date_overrides`, whose `fulfillment` sub-document is the
// same shape and is resolved through the same helper.
//
// Idempotency: the filter matches only documents that still carry the legacy
// field, so a second run matches nothing and reports 0.
// ---------------------------------------------------------------------------

export const LEGACY_FULFILLMENT_FIELD = 'pickupAndDelivery';

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export interface SplitFulfillmentLegsMigrationResult {
  /** Availability configs carrying at least one legacy day. */
  configsMatched: number;
  configsUpdated: number;
  /** Date overrides carrying the legacy field. */
  overridesMatched: number;
  overridesUpdated: number;
  /** Every affected _id, logged so the change is auditable. */
  affectedIds: string[];
}

export interface SplitFulfillmentLegsMigrationOptions {
  connection: Connection;
  /** false ⇒ dry run: count and list, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

interface LegacyFulfillment {
  pickupAndDelivery?: boolean;
  providerPickup?: boolean;
  providerDelivery?: boolean;
}

/** The legacy value wins only where the new fields are absent. */
function splitOf(fulfillment: LegacyFulfillment): {
  providerPickup: boolean;
  providerDelivery: boolean;
} {
  const legacy = fulfillment.pickupAndDelivery ?? true;
  return {
    providerPickup: fulfillment.providerPickup ?? legacy,
    providerDelivery: fulfillment.providerDelivery ?? legacy,
  };
}

export async function migrateSplitFulfillmentLegs(
  options: SplitFulfillmentLegsMigrationOptions,
): Promise<SplitFulfillmentLegsMigrationResult> {
  const { connection, apply, log = () => undefined } = options;
  const configs = connection.collection('booking_availability_configs');
  const overrides = connection.collection('booking_date_overrides');

  const affected = new Set<string>();
  const result: SplitFulfillmentLegsMigrationResult = {
    configsMatched: 0,
    configsUpdated: 0,
    overridesMatched: 0,
    overridesUpdated: 0,
    affectedIds: [],
  };

  // ── Weekly configs ────────────────────────────────────────────────────────
  const configFilter = {
    $or: WEEKDAYS.map((d) => ({
      [`weekly.${d}.fulfillment.${LEGACY_FULFILLMENT_FIELD}`]: {
        $exists: true,
      },
    })),
  };
  const configDocs = await configs.find(configFilter).toArray();
  result.configsMatched = configDocs.length;

  for (const doc of configDocs) {
    const id = String(doc._id);
    affected.add(id);
    const weekly = (doc.weekly ?? {}) as Record<
      string,
      { fulfillment?: LegacyFulfillment } | undefined
    >;
    const set: Record<string, boolean> = {};
    const unset: Record<string, ''> = {};

    for (const day of WEEKDAYS) {
      const fulfillment = weekly[day]?.fulfillment;
      if (!fulfillment || fulfillment[LEGACY_FULFILLMENT_FIELD] === undefined) {
        continue;
      }
      const { providerPickup, providerDelivery } = splitOf(fulfillment);
      set[`weekly.${day}.fulfillment.providerPickup`] = providerPickup;
      set[`weekly.${day}.fulfillment.providerDelivery`] = providerDelivery;
      unset[`weekly.${day}.fulfillment.${LEGACY_FULFILLMENT_FIELD}`] = '';
      log(
        `booking_availability_config ${id} ${day}: ` +
          `${LEGACY_FULFILLMENT_FIELD}=${fulfillment[LEGACY_FULFILLMENT_FIELD]} ` +
          `→ providerPickup=${providerPickup}, providerDelivery=${providerDelivery}`,
      );
    }

    if (!apply || Object.keys(set).length === 0) continue;
    const res = await configs.updateOne(
      { _id: doc._id },
      { $set: set, $unset: unset },
    );
    result.configsUpdated += res.modifiedCount;
  }

  // ── Date overrides ────────────────────────────────────────────────────────
  const overrideFilter = {
    [`fulfillment.${LEGACY_FULFILLMENT_FIELD}`]: { $exists: true },
  };
  const overrideDocs = await overrides.find(overrideFilter).toArray();
  result.overridesMatched = overrideDocs.length;

  for (const doc of overrideDocs) {
    const id = String(doc._id);
    affected.add(id);
    const fulfillment = (doc.fulfillment ?? {}) as LegacyFulfillment;
    const { providerPickup, providerDelivery } = splitOf(fulfillment);
    log(
      `booking_date_override ${id}: ` +
        `${LEGACY_FULFILLMENT_FIELD}=${fulfillment[LEGACY_FULFILLMENT_FIELD]} ` +
        `→ providerPickup=${providerPickup}, providerDelivery=${providerDelivery}`,
    );

    if (!apply) continue;
    const res = await overrides.updateOne(
      { _id: doc._id },
      {
        $set: {
          'fulfillment.providerPickup': providerPickup,
          'fulfillment.providerDelivery': providerDelivery,
        },
        $unset: { [`fulfillment.${LEGACY_FULFILLMENT_FIELD}`]: '' },
      },
    );
    result.overridesUpdated += res.modifiedCount;
  }

  result.affectedIds = [...affected];
  return result;
}
