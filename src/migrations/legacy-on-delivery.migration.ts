import type { Connection } from 'mongoose';
import {
  LEGACY_PAYMENT_TIMING_ON_DELIVERY,
  PaymentTiming,
} from '../online-orders/schemas/order-status.enum';

// ---------------------------------------------------------------------------
// GAP-P0-028 removed PaymentTiming.ON_DELIVERY and
// PaymentStatus.TO_PAY_ON_DELIVERY from the contract. Reads tolerate the legacy
// values, writes reject them. This migration rewrites the stored values so the
// shim can go away.
//
// The timing mapping is SPLIT, because deferred settlement now exists again as
// AT_FINAL_HANDOVER (§14, 2026-08-15):
//
//   paymentTiming 'on_delivery', never collected, still live → 'at_final_handover'
//   paymentTiming 'on_delivery', collected or terminal       → 'on_pickup'
//   paymentStatus 'to_pay_on_delivery'                       → 'unpaid'
//
// Before AT_FINAL_HANDOVER existed, everything collapsed to 'on_pickup' because
// that was the only value left. Doing that now would tell a customer holding an
// uncollected legacy order that they paid at pickup, so an order that genuinely
// still owes money is mapped to the value that says so.
//
// Nothing about settlement depends on this: the service gates on arithmetic
// (customerTotal − collected > 0), which handles a legacy order correctly
// whichever string it stores. The rewrite is about what the customer is told.
//
// paymentStatus is a derived, resolver-computed field in Phase 2 and is not
// stored on new orders — but pre-hardening documents may still carry a stale
// stored copy, so it is cleaned up in the same pass.
//
// Idempotency: the filters match only the legacy values, so a second run
// matches nothing and reports 0.
// ---------------------------------------------------------------------------

export const LEGACY_PAYMENT_STATUS_TO_PAY_ON_DELIVERY = 'to_pay_on_delivery';
export const REPLACEMENT_PAYMENT_STATUS = 'unpaid';

// Statuses past the point where anything could still be collected. An
// 'on_delivery' order sitting in one of these was either paid or is over.
const TERMINAL_STATUSES = [
  'completed',
  'cancelled',
  'rejected_by_provider',
  'refunded',
  'abandoned_unsettled',
];

export interface LegacyOnDeliveryMigrationResult {
  /** Orders whose paymentTiming was (or would be) rewritten. */
  paymentTimingMatched: number;
  paymentTimingUpdated: number;
  /** Of those, how many map to each destination. */
  paymentTimingToHandover: number;
  paymentTimingToPickup: number;
  /** Orders backfilled with pricing.platformFeeConsumedCentavos. */
  feeConsumedBackfillMatched: number;
  feeConsumedBackfillUpdated: number;
  /** Orders whose stored paymentStatus was (or would be) rewritten. */
  paymentStatusMatched: number;
  paymentStatusUpdated: number;
  /** Every affected order _id, logged so the change is auditable. */
  affectedOrderIds: string[];
}

export interface LegacyOnDeliveryMigrationOptions {
  connection: Connection;
  /** false ⇒ dry run: count and list, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

export async function migrateLegacyOnDelivery(
  options: LegacyOnDeliveryMigrationOptions,
): Promise<LegacyOnDeliveryMigrationResult> {
  const { connection, apply, log = () => undefined } = options;
  const orders = connection.collection('online_orders');

  const timingFilter = {
    paymentTiming: LEGACY_PAYMENT_TIMING_ON_DELIVERY,
  };
  // Still owes: never collected, and not past the point of collecting.
  const unsettledFilter = {
    ...timingFilter,
    'paymentSummary.collectedAt': null,
    status: { $nin: TERMINAL_STATUSES },
  };
  const settledFilter = {
    ...timingFilter,
    $or: [
      { 'paymentSummary.collectedAt': { $ne: null } },
      { status: { $in: TERMINAL_STATUSES } },
    ],
  };
  const statusFilter = {
    paymentStatus: LEGACY_PAYMENT_STATUS_TO_PAY_ON_DELIVERY,
  };
  // Any order that was ever collected had its whole platform fee debited at
  // pickup — that was unconditional. `platformFeeConsumedCentavos` records
  // that fact going forward; without this backfill an old order reaching
  // delivery would look never-charged and be debited a second time.
  //
  // Orders carrying an approved quality-hold surcharge are marked as having
  // consumed that portion too. That is deliberate: the surcharge fee was never
  // actually debited under the old code, and pretending otherwise would have
  // the first settlement retro-charge a fee the provider was never told about.
  // This freezes history as it really is; only new surcharges get charged.
  const feeBackfillFilter = {
    'paymentSummary.collectedAt': { $ne: null },
    'pricing.platformFeeConsumedCentavos': { $exists: false },
  };

  const timingDocs = await orders
    .find(timingFilter, { projection: { _id: 1 } })
    .toArray();
  const unsettledCount = await orders.countDocuments(unsettledFilter);
  const feeBackfillCount = await orders.countDocuments(feeBackfillFilter);
  const statusDocs = await orders
    .find(statusFilter, { projection: { _id: 1 } })
    .toArray();

  const affected = new Set<string>([
    ...timingDocs.map((d) => String(d._id)),
    ...statusDocs.map((d) => String(d._id)),
  ]);

  const result: LegacyOnDeliveryMigrationResult = {
    paymentTimingMatched: timingDocs.length,
    paymentTimingUpdated: 0,
    paymentTimingToHandover: unsettledCount,
    paymentTimingToPickup: timingDocs.length - unsettledCount,
    feeConsumedBackfillMatched: feeBackfillCount,
    feeConsumedBackfillUpdated: 0,
    paymentStatusMatched: statusDocs.length,
    paymentStatusUpdated: 0,
    affectedOrderIds: [...affected],
  };

  for (const id of result.affectedOrderIds) {
    log(`online_order ${id}: legacy on_delivery payment fields`);
  }

  if (!apply) return result;

  if (timingDocs.length > 0) {
    // Order matters: rewrite the unsettled ones first. Doing it the other way
    // round would leave the settled filter matching documents the first pass
    // had already moved to 'on_pickup' — harmless, but the counts would lie.
    const toHandover = await orders.updateMany(unsettledFilter, {
      $set: { paymentTiming: PaymentTiming.AT_FINAL_HANDOVER },
    });
    const toPickup = await orders.updateMany(settledFilter, {
      $set: { paymentTiming: PaymentTiming.ON_PICKUP },
    });
    result.paymentTimingUpdated =
      toHandover.modifiedCount + toPickup.modifiedCount;
  }
  if (statusDocs.length > 0) {
    const res = await orders.updateMany(statusFilter, {
      $set: { paymentStatus: REPLACEMENT_PAYMENT_STATUS },
    });
    result.paymentStatusUpdated = res.modifiedCount;
  }
  if (feeBackfillCount > 0) {
    // $set from another field needs an aggregation pipeline update.
    const res = await orders.updateMany(feeBackfillFilter, [
      {
        $set: {
          'pricing.platformFeeConsumedCentavos': {
            $ifNull: ['$pricing.platformFeeCentavos', 0],
          },
        },
      },
    ]);
    result.feeConsumedBackfillUpdated = res.modifiedCount;
  }

  return result;
}
