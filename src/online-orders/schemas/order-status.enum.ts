import { registerEnumType } from '@nestjs/graphql';
import { ConflictException } from '@nestjs/common';

// One canonical enum shared by Customer and Partner apps alike — see
// phase2-settled-decisions.md §15. Replaces the two divergent lists the
// original TSD had (Part II Appendix A vs Part III §7.3).
export enum OrderStatus {
  // Creation
  DRAFT = 'draft',
  PRICING_VALIDATED = 'pricing_validated',
  PENDING_PROVIDER_ACCEPTANCE = 'pending_provider_acceptance',

  // Provider decision
  PROVIDER_CHANGE_PROPOSED = 'provider_change_proposed',
  ACCEPTED_BY_PROVIDER = 'accepted_by_provider',
  REJECTED_BY_PROVIDER = 'rejected_by_provider',
  CANCELLED = 'cancelled',

  // Pickup — provider_pickup path only
  AWAITING_PICKUP_ASSIGNMENT = 'awaiting_pickup_assignment',
  PICKUP_ASSIGNED = 'pickup_assigned',
  PICKUP_EN_ROUTE = 'pickup_en_route',
  PICKUP_ARRIVED = 'pickup_arrived',
  // Weighed/counted and priced, payment not yet collected (or deferred) —
  // the split of the old atomic recordPickup into recordPickupWeight +
  // recordPickupPayment. Lets the customer see the confirmed weight/total
  // before the courier finishes the money step.
  PICKUP_WEIGHED = 'pickup_weighed',
  PICKED_UP_FROM_CUSTOMER = 'picked_up_from_customer',
  PICKUP_ATTEMPT_FAILED = 'pickup_attempt_failed',
  AWAITING_PICKUP_RESCHEDULE = 'awaiting_pickup_reschedule',

  // Drop-off — customer_dropoff path only
  RECEIVED_BY_PROVIDER = 'received_by_provider',

  // Processing
  LAUNDRY_IN_PROGRESS = 'laundry_in_progress',
  LAUNDRY_QUALITY_HOLD = 'laundry_quality_hold',
  LAUNDRY_READY = 'laundry_ready',

  // Return-mode exception (rare)
  AWAITING_RETURN_SELECTION = 'awaiting_return_selection',

  // Return delivery
  AWAITING_RETURN_ASSIGNMENT = 'awaiting_return_assignment',
  RETURN_ASSIGNED = 'return_assigned',
  RETURN_EN_ROUTE = 'return_en_route',
  RETURN_ARRIVED = 'return_arrived',
  DELIVERED_TO_CUSTOMER = 'delivered_to_customer',
  DELIVERY_ATTEMPTED = 'delivery_attempted',
  RETURNED_TO_PROVIDER = 'returned_to_provider',
  AWAITING_REDELIVERY_SELECTION = 'awaiting_redelivery_selection',
  REDELIVERY_SCHEDULED = 'redelivery_scheduled',

  // Self-pickup
  AWAITING_CUSTOMER_PICKUP = 'awaiting_customer_pickup',
  CUSTOMER_PICKUP_VERIFIED = 'customer_pickup_verified',

  // Terminal
  COMPLETED = 'completed',
  REFUNDED = 'refunded',
  DISPUTED = 'disputed',
  // Laundry was finished but the customer never settled and stopped engaging.
  // Reached only by the abandonment sweep, only from a resting state where the
  // provider still physically holds the goods. Stops automatic redelivery by
  // virtue of the transition table; support can reinstate.
  ABANDONED_UNSETTLED = 'abandoned_unsettled',
}
registerEnumType(OrderStatus, { name: 'OrderStatus' });

// Which slice of a courier's task feed to return. The rider app polls ACTIVE
// every 15s (small, changes constantly) and pulls COMPLETED only on focus and
// pull-to-refresh (large, effectively immutable) — asking for ALL every tick
// meant re-sending a week of finished work four times a minute.
export enum CourierTaskScope {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  ALL = 'all',
}
registerEnumType(CourierTaskScope, { name: 'CourierTaskScope' });

export enum FulfillmentPickupMode {
  PROVIDER_PICKUP = 'provider_pickup',
  CUSTOMER_DROPOFF = 'customer_dropoff',
}
registerEnumType(FulfillmentPickupMode, { name: 'FulfillmentPickupMode' });

export enum FulfillmentReturnMode {
  PROVIDER_DELIVERY = 'provider_delivery',
  CUSTOMER_SELF_PICKUP = 'customer_self_pickup',
}
registerEnumType(FulfillmentReturnMode, { name: 'FulfillmentReturnMode' });

export enum DeliverySubMode {
  FREE_BATCH = 'free_batch',
  /**
   * @deprecated Speed is a turnaround promise, not a delivery mode — see
   * TurnaroundTierCode. Tolerated on READ so placed orders still resolve;
   * REJECTED on write (createOrder/quoteOrder). Remove once
   * `scripts/migrations/migrate-express-to-turnaround.ts` has run everywhere.
   */
  EXPRESS = 'express',
  SCHEDULED_PAID = 'scheduled_paid',
}
registerEnumType(DeliverySubMode, { name: 'DeliverySubMode' });

/**
 * How fast the laundry must be DONE, measured from the moment the provider
 * physically has it. Independent of who moves it and of what that costs, so a
 * self-pickup customer can buy speed — impossible while speed was a delivery
 * sub-mode.
 */
export enum TurnaroundTierCode {
  STANDARD = 'standard',
  EXPRESS = 'express',
}
registerEnumType(TurnaroundTierCode, { name: 'TurnaroundTierCode' });

/**
 * Which transport leg an action refers to. Chat has its own ChatLegType with
 * the same members; they are deliberately separate types rather than one shared
 * enum, so the order domain does not depend on the chat module's SDL.
 */
export enum OrderLeg {
  PICKUP = 'pickup',
  RETURN = 'return',
}
registerEnumType(OrderLeg, { name: 'OrderLeg' });

export enum ProviderType {
  MERCHANT = 'merchant',
  WASHER = 'washer',
}
registerEnumType(ProviderType, { name: 'ProviderType' });

export enum PaymentMethod {
  CASH = 'cash',
  EWALLET_OUTSIDE_APP = 'ewallet_outside_app',
}
// GraphQL name is 'OnlinePaymentMethod' to avoid colliding with the Phase 1
// pos_transactions PaymentMethod enum (gcash/maya/qph/card/…) which already
// owns the 'PaymentMethod' SDL type the merchant app consumes.
registerEnumType(PaymentMethod, { name: 'OnlinePaymentMethod' });

// When the customer pays.
//
// GAP-P0-028 originally collapsed this to ON_PICKUP alone, enforcing
// payment-before-custody. Product reopened that decision (see
// phase2-settled-decisions.md §14, 2026-08-15): a provider may opt in to
// deferred settlement, and the customer then pays the whole amount when the
// laundry comes back. Still all-or-nothing — there is no partial-payment path.
//
// The choice is recorded at the weigh-in, not at booking: the full amount does
// not exist until the load is measured, so a booking-time choice would be the
// customer deferring an estimate.
export enum PaymentTiming {
  ON_PICKUP = 'on_pickup',
  AT_FINAL_HANDOVER = 'at_final_handover',
}
registerEnumType(PaymentTiming, { name: 'PaymentTiming' });

// Legacy value that pre-hardening dev orders may still carry in Mongo. Means
// exactly what AT_FINAL_HANDOVER means, so it is mapped to that on read and
// rewritten by scripts/migrations. Tolerated on READ only — never accepted on
// write, CreateOrderInput validates against the enum above.
//
// Nothing in the service branches on it any more: settlement is gated on
// arithmetic (customerTotal − collected > 0), which handles a legacy
// uncollected order correctly whatever string it stores.
export const LEGACY_PAYMENT_TIMING_ON_DELIVERY = 'on_delivery';

// Resolved payment state shown to customer + provider/rider. Derived, not
// stored: PAID once collected in full, BALANCE_DUE when a post-collection
// surcharge (quality hold) left a shortfall, else UNPAID.
// (TO_PAY_ON_DELIVERY removed with the ON_DELIVERY contract — GAP-P0-028.)
export enum PaymentStatus {
  UNPAID = 'unpaid',
  BALANCE_DUE = 'balance_due',
  PAID = 'paid',
}
registerEnumType(PaymentStatus, { name: 'OnlinePaymentStatus' });

// Who was responsible for a failed pickup/delivery attempt — drives fee
// treatment (customer-caused may carry a fee, provider/system-caused never does).
export enum AttemptResponsibility {
  CUSTOMER = 'customer',
  PROVIDER = 'provider',
  SYSTEM = 'system',
}
registerEnumType(AttemptResponsibility, { name: 'AttemptResponsibility' });

/**
 * Allowed next states per current state. Any transition not listed here is
 * rejected — skipped, reversed, or invented states are not allowed, per the
 * TSD's state-machine rule (carried over from Part II Appendix A / Part III §7.4).
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.DRAFT]: [OrderStatus.PRICING_VALIDATED, OrderStatus.CANCELLED],
  [OrderStatus.PRICING_VALIDATED]: [
    OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PENDING_PROVIDER_ACCEPTANCE]: [
    OrderStatus.ACCEPTED_BY_PROVIDER,
    OrderStatus.PROVIDER_CHANGE_PROPOSED,
    OrderStatus.REJECTED_BY_PROVIDER,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PROVIDER_CHANGE_PROPOSED]: [
    OrderStatus.ACCEPTED_BY_PROVIDER,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.ACCEPTED_BY_PROVIDER]: [
    OrderStatus.AWAITING_PICKUP_ASSIGNMENT, // provider_pickup path
    OrderStatus.RECEIVED_BY_PROVIDER, // customer_dropoff path
    OrderStatus.CANCELLED, // provider-caused cancellation post-acceptance
  ],
  [OrderStatus.REJECTED_BY_PROVIDER]: [],
  [OrderStatus.CANCELLED]: [],

  // Pickup
  [OrderStatus.AWAITING_PICKUP_ASSIGNMENT]: [OrderStatus.PICKUP_ASSIGNED],
  [OrderStatus.PICKUP_ASSIGNED]: [OrderStatus.PICKUP_EN_ROUTE],
  [OrderStatus.PICKUP_EN_ROUTE]: [OrderStatus.PICKUP_ARRIVED],
  [OrderStatus.PICKUP_ARRIVED]: [
    OrderStatus.PICKUP_WEIGHED,
    OrderStatus.PICKUP_ATTEMPT_FAILED,
  ],
  // Self-loop: the courier can re-weigh/correct while still in this status —
  // recordPickupWeight re-finalizes pricing idempotently (finalizePricing
  // recomputes from scratch each call; consumeOutstandingFee only debits the
  // delta). Once recordPickupPayment advances the order past this status, the
  // self-loop is no longer reachable — no edits after money changes hands.
  [OrderStatus.PICKUP_WEIGHED]: [
    OrderStatus.PICKUP_WEIGHED,
    OrderStatus.PICKED_UP_FROM_CUSTOMER,
  ],
  [OrderStatus.PICKED_UP_FROM_CUSTOMER]: [OrderStatus.LAUNDRY_IN_PROGRESS],
  [OrderStatus.PICKUP_ATTEMPT_FAILED]: [
    OrderStatus.PICKUP_ASSIGNED, // same-day retry
    OrderStatus.AWAITING_PICKUP_RESCHEDULE, // whole day failed
  ],
  [OrderStatus.AWAITING_PICKUP_RESCHEDULE]: [
    OrderStatus.PICKUP_ASSIGNED, // reschedule to a new day
    OrderStatus.CANCELLED, // no refund — nothing was collected
  ],

  // Drop-off
  [OrderStatus.RECEIVED_BY_PROVIDER]: [OrderStatus.LAUNDRY_IN_PROGRESS],

  // Processing
  [OrderStatus.LAUNDRY_IN_PROGRESS]: [
    OrderStatus.LAUNDRY_QUALITY_HOLD,
    OrderStatus.LAUNDRY_READY,
  ],
  [OrderStatus.LAUNDRY_QUALITY_HOLD]: [
    OrderStatus.LAUNDRY_IN_PROGRESS, // always resolves back into continuing — never a full cancellation
  ],
  [OrderStatus.LAUNDRY_READY]: [
    OrderStatus.AWAITING_RETURN_SELECTION, // exception: original mode unavailable
    OrderStatus.AWAITING_RETURN_ASSIGNMENT, // provider delivery, normal path
    OrderStatus.AWAITING_CUSTOMER_PICKUP, // self-pickup path
  ],
  [OrderStatus.AWAITING_RETURN_SELECTION]: [
    OrderStatus.AWAITING_RETURN_ASSIGNMENT,
    OrderStatus.AWAITING_CUSTOMER_PICKUP,
  ],

  // Return delivery
  [OrderStatus.AWAITING_RETURN_ASSIGNMENT]: [OrderStatus.RETURN_ASSIGNED],
  [OrderStatus.RETURN_ASSIGNED]: [OrderStatus.RETURN_EN_ROUTE],
  [OrderStatus.RETURN_EN_ROUTE]: [OrderStatus.RETURN_ARRIVED],
  [OrderStatus.RETURN_ARRIVED]: [
    OrderStatus.DELIVERED_TO_CUSTOMER,
    OrderStatus.DELIVERY_ATTEMPTED,
  ],
  [OrderStatus.DELIVERED_TO_CUSTOMER]: [OrderStatus.COMPLETED],
  [OrderStatus.DELIVERY_ATTEMPTED]: [OrderStatus.RETURNED_TO_PROVIDER],
  [OrderStatus.RETURNED_TO_PROVIDER]: [
    OrderStatus.AWAITING_REDELIVERY_SELECTION,
  ],
  [OrderStatus.AWAITING_REDELIVERY_SELECTION]: [
    OrderStatus.REDELIVERY_SCHEDULED,
    OrderStatus.ABANDONED_UNSETTLED, // window elapsed with a balance outstanding
  ],
  [OrderStatus.REDELIVERY_SCHEDULED]: [OrderStatus.RETURN_ASSIGNED], // unlimited attempts, no cap

  // Self-pickup
  [OrderStatus.AWAITING_CUSTOMER_PICKUP]: [
    OrderStatus.CUSTOMER_PICKUP_VERIFIED,
    OrderStatus.ABANDONED_UNSETTLED, // customer never came back and never paid
  ],
  [OrderStatus.CUSTOMER_PICKUP_VERIFIED]: [OrderStatus.COMPLETED],

  // Terminal
  [OrderStatus.COMPLETED]: [OrderStatus.DISPUTED],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.DISPUTED]: [], // overlay — never erases history; handled as a flag in practice, see below
  // Not strictly terminal: automatic redelivery is stopped (the sweep and
  // scheduleRedelivery both go through assertValidTransition, and neither of
  // these edges is reachable without the admin-only reinstate mutation), but a
  // customer who turns up later with cash can still be served.
  [OrderStatus.ABANDONED_UNSETTLED]: [
    OrderStatus.AWAITING_REDELIVERY_SELECTION,
    OrderStatus.AWAITING_CUSTOMER_PICKUP,
  ],
};

export function assertValidTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  const allowed = ORDER_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ConflictException(
      `Invalid order status transition: ${from} -> ${to}`,
    );
  }
}

// Daily-cap semantics (GAP-H-013): a slot is consumed by an order the washer
// has ACCEPTED today (or that has progressed beyond acceptance — including
// completed work, which still occupied a slot). Never-accepted terminations
// (rejected/cancelled pre-acceptance) and refunds free their slot. Orders
// merely awaiting her decision do NOT consume a slot — otherwise spam
// bookings could lock her out of accepting real work.
//
// Single source of truth for both the acceptance-time atomic guard
// (OnlineOrdersService.reserveDailyCapSlot) and any "bookings today" display
// (WasherService dashboard stats) — they must count the same thing or the
// number a washer sees will disagree with what actually blocks her.
export const CAP_EXEMPT_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.DRAFT,
  OrderStatus.PRICING_VALIDATED,
  OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
  OrderStatus.PROVIDER_CHANGE_PROPOSED,
  OrderStatus.REJECTED_BY_PROVIDER,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
]);
export const CAP_COUNTED_STATUSES: OrderStatus[] = Object.values(
  OrderStatus,
).filter((s) => !CAP_EXEMPT_STATUSES.has(s));
