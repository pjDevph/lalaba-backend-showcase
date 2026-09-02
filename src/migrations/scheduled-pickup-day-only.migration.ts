import type { Connection } from 'mongoose';

// ---------------------------------------------------------------------------
// `fulfillment.scheduledPickup` used to carry a 30-minute window:
//
//   { date, startTime, endTime, label: '8:00 AM – 8:30 AM' }
//
// It now carries a day:
//
//   { date, label: 'Mon, Aug 18' }
//
// The window went because it was never a promise anyone could keep — a free
// pickup is batched with nearby collections — and because no provider surface
// ever displayed it, so the person meant to honour it could not see it.
//
// `date` is deliberately untouched. Day capacity is counted by grouping orders
// on exactly that field, so preserving it means every existing booking keeps
// its place in its provider's day and no count has to be rebuilt.
//
// `label` is rewritten rather than dropped: it is a snapshot the order history
// renders directly, and leaving '8:00 AM – 8:30 AM' on file would keep showing
// customers a time the system no longer honours.
//
// Idempotency: the filter matches only documents that still have startTime, so
// a second run matches nothing and reports 0.
// ---------------------------------------------------------------------------

export const ONLINE_ORDERS_COLLECTION = 'online_orders';

const HUMAN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HUMAN_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Mirrors ph-time.util dayLabel — duplicated so the migration is standalone. */
export function dayLabelFor(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${HUMAN_DAYS[parsed.getUTCDay()]}, ${HUMAN_MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCDate()}`;
}

export interface ScheduledPickupDayOnlyResult {
  matched: number;
  updated: number;
  /** Orders with a window but NO date — they cannot be repaired, only reported. */
  undatable: string[];
}

export interface ScheduledPickupDayOnlyOptions {
  connection: Connection;
  /** false ⇒ dry run: count and list, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

const HAS_WINDOW = {
  'fulfillment.scheduledPickup.startTime': { $exists: true },
};

export async function migrateScheduledPickupToDayOnly(
  options: ScheduledPickupDayOnlyOptions,
): Promise<ScheduledPickupDayOnlyResult> {
  const { connection, apply, log = () => undefined } = options;
  const orders = connection.collection(ONLINE_ORDERS_COLLECTION);

  const docs = await orders
    .find(HAS_WINDOW, { projection: { _id: 1, fulfillment: 1 } })
    .toArray();

  const result: ScheduledPickupDayOnlyResult = {
    matched: docs.length,
    updated: 0,
    undatable: [],
  };

  for (const doc of docs) {
    const pickup = (doc.fulfillment as { scheduledPickup?: { date?: string } })
      ?.scheduledPickup;
    const date = pickup?.date;

    // A window with no date should not exist, but if one does, unsetting the
    // times would leave an order that counts toward no day at all. Report it
    // and leave it exactly as found rather than quietly making it worse.
    if (!date) {
      result.undatable.push(String(doc._id));
      log(`online_order ${String(doc._id)}: window with no date — SKIPPED`);
      continue;
    }

    log(`online_order ${String(doc._id)}: ${date} → ${dayLabelFor(date)}`);
    if (!apply) continue;

    const res = await orders.updateOne(
      { _id: doc._id },
      {
        $set: { 'fulfillment.scheduledPickup.label': dayLabelFor(date) },
        $unset: {
          'fulfillment.scheduledPickup.startTime': '',
          'fulfillment.scheduledPickup.endTime': '',
        },
      },
    );
    result.updated += res.modifiedCount;
  }

  return result;
}
