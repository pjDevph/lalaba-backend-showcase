// src/online-orders/platform-fee-parts.util.ts
//
// `platformFeeCentavos` has two sources, and only one of them is ever
// waivable.
//
// The field is written three times over an order's life: an estimate at
// create, a reprice once the laundry is actually weighed, and an addition when
// a customer approves a quality-hold surcharge. After the fact the causes are
// indistinguishable — which is fine while the whole amount is simply owed, and
// wrong the moment any of it can be forgiven.
//
// The distinction that matters is not "before vs after the promotion was
// granted". A customer who estimates 5 kg and hands over 8 kg legitimately
// raises the fee, and "no Lalaba fee on your first five orders" plainly covers
// that — the provider did nothing wrong. A quality surcharge is the opposite:
// it exists because something went wrong, and a marketing promise must not
// quietly cancel it. Freezing the waiver at the amount known when it was
// granted would get the common case backwards.

import type { OrderPricing } from './schemas/online-order.schema';

/** The part of the platform fee that came from a penalty. Never waivable. */
export function surchargePlatformFeeCentavos(
  pricing:
    Pick<OrderPricing, 'platformFeeSurchargeCentavos'> | null | undefined,
): number {
  return Math.max(0, pricing?.platformFeeSurchargeCentavos ?? 0);
}

/**
 * The part of the platform fee a promotion may forgive: everything the fee
 * rule produced from the service price, and nothing that came from a
 * surcharge.
 *
 * Tracks repricing for free — the total moves when the laundry is weighed and
 * the surcharge portion does not, so the difference follows the real fee
 * without anything having to be recalculated or re-granted.
 */
export function waivablePlatformFeeCentavos(
  pricing:
    | Pick<OrderPricing, 'platformFeeCentavos' | 'platformFeeSurchargeCentavos'>
    | null
    | undefined,
): number {
  const total = Math.max(0, pricing?.platformFeeCentavos ?? 0);
  // Clamped rather than trusted: an order written by an older build has no
  // surcharge figure at all, and one written by a future bug could have a
  // larger one than the total. Neither should produce a negative waiver.
  return Math.max(0, total - surchargePlatformFeeCentavos(pricing));
}

/**
 * What the provider actually owes: the fee, less any promotional discount.
 *
 * This is the number the wallet charges against. `platformFeeCentavos` remains
 * the gross fee the rule produced — a waiver is not wallet money, so it must
 * never be staged as a debit followed by a matching credit. There is no ₱20 to
 * move; the provider simply owes ₱0.
 */
export function chargeablePlatformFeeCentavos(
  pricing:
    | Pick<OrderPricing, 'platformFeeCentavos' | 'platformFeeDiscountCentavos'>
    | null
    | undefined,
): number {
  const gross = Math.max(0, pricing?.platformFeeCentavos ?? 0);
  const discount = Math.max(0, pricing?.platformFeeDiscountCentavos ?? 0);
  // Clamped: a discount larger than the fee — possible if the fee is revised
  // DOWN after a waiver was granted — owes nothing rather than a credit. The
  // wallet has its own reversal path for money actually taken.
  return Math.max(0, gross - discount);
}
