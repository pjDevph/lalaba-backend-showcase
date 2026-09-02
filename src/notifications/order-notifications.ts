// Which order transitions are worth telling someone about, and what to say.
//
// The order lifecycle has ~37 statuses. Notifying on every one would train
// people to ignore the app, so this table is deliberately short: a transition
// earns a notification only when the recipient either has to DO something, or
// would otherwise be left wondering (their money, their laundry, their van).
//
// Everything not listed here is a silent status change, visible in the order
// screen for anyone who looks. That is the default, and adding a row should be
// a decision rather than a reflex.
//
// This table is the tuning point. If the apps feel noisy or quiet, edit here —
// nothing else needs to change.

import { NotificationCategory, NotificationType } from './notification.enums';
import { OrderStatus } from '../online-orders/schemas/order-status.enum';

/** Who a row is for. Resolved to a uid against the order at send time. */
export type OrderAudience =
  'CUSTOMER' | 'PROVIDER' | 'COURIER_PICKUP' | 'COURIER_RETURN';

export interface OrderNotificationSpec {
  audience: OrderAudience;
  /**
   * ACTION_NEEDED is split from STATUS so a client can style and sort urgency
   * without knowing the status table. Use it only when the recipient is
   * BLOCKING the order — not merely interested in it.
   */
  type: NotificationType;
  title: string;
  /**
   * No order reference in here. Clients render it as its own metadata line
   * from `data.orderNumber`, and inlining it made every row read like a
   * receipt instead of a sentence.
   */
  body: (providerName: string) => string;
}

const status = (
  audience: OrderAudience,
  title: string,
  body: (providerName: string) => string,
): OrderNotificationSpec => ({
  audience,
  type: NotificationType.ORDER_STATUS,
  title,
  body,
});

const action = (
  audience: OrderAudience,
  title: string,
  body: (providerName: string) => string,
): OrderNotificationSpec => ({
  audience,
  type: NotificationType.ORDER_ACTION_NEEDED,
  title,
  body,
});

export const ORDER_NOTIFICATIONS: Partial<
  Record<OrderStatus, OrderNotificationSpec[]>
> = {
  // ── Booking ───────────────────────────────────────────────────────────────
  // The provider is blocking here: nothing moves until they accept.
  [OrderStatus.PENDING_PROVIDER_ACCEPTANCE]: [
    action(
      'PROVIDER',
      'New booking',
      () => `A new booking is waiting for you to accept.`,
    ),
  ],
  [OrderStatus.ACCEPTED_BY_PROVIDER]: [
    status(
      'CUSTOMER',
      'Booking accepted',
      (p) => `${p} accepted your booking.`,
    ),
  ],
  [OrderStatus.REJECTED_BY_PROVIDER]: [
    status(
      'CUSTOMER',
      'Booking declined',
      (p) => `${p} could not take your booking.`,
    ),
  ],
  // A proposed change re-opens the price or the schedule — the customer must
  // answer before anything proceeds.
  [OrderStatus.PROVIDER_CHANGE_PROPOSED]: [
    action(
      'CUSTOMER',
      'Change proposed',
      (p) => `${p} proposed a change. Review it to continue.`,
    ),
  ],
  [OrderStatus.CANCELLED]: [
    status('CUSTOMER', 'Order cancelled', () => `This booking was cancelled.`),
    status('PROVIDER', 'Order cancelled', () => `This booking was cancelled.`),
  ],

  // ── Pickup ────────────────────────────────────────────────────────────────
  [OrderStatus.PICKUP_ASSIGNED]: [
    status(
      'COURIER_PICKUP',
      'New pickup assigned',
      () => `You have been assigned this pickup.`,
    ),
  ],
  [OrderStatus.PICKUP_EN_ROUTE]: [
    status(
      'CUSTOMER',
      'Your courier is on the way',
      () => `Your courier is heading over to collect your laundry.`,
    ),
  ],
  // The price stops being an estimate here. This is the one the customer most
  // needs, because it is the first time they learn what they owe.
  [OrderStatus.PICKUP_WEIGHED]: [
    status(
      'CUSTOMER',
      'Laundry weighed',
      () => `Your laundry has been weighed and the final price is ready.`,
    ),
  ],
  [OrderStatus.PICKUP_ATTEMPT_FAILED]: [
    action(
      'CUSTOMER',
      'Pickup could not be completed',
      () => `We could not collect your laundry. Reschedule to continue.`,
    ),
  ],

  // ── In the shop ───────────────────────────────────────────────────────────
  // Deliberately NOT notified: RECEIVED_BY_PROVIDER. The provider is the one
  // who just took the laundry in — telling them about their own action is
  // the definition of noise.
  // A hold means the provider found something they will not wash without a
  // decision — it costs the customer time and possibly money.
  [OrderStatus.LAUNDRY_QUALITY_HOLD]: [
    action(
      'CUSTOMER',
      'Action needed on your laundry',
      (p) => `${p} put your laundry on hold and needs your decision.`,
    ),
  ],
  [OrderStatus.LAUNDRY_READY]: [
    status(
      'CUSTOMER',
      'Your laundry is ready',
      (p) => `${p} has finished your laundry.`,
    ),
  ],

  // ── Return ────────────────────────────────────────────────────────────────
  // The order sits still until the customer says how they want it back.
  [OrderStatus.AWAITING_RETURN_SELECTION]: [
    action(
      'CUSTOMER',
      'Choose how to get your laundry',
      () => `Your laundry is ready. Pick delivery or collection to continue.`,
    ),
  ],
  [OrderStatus.RETURN_ASSIGNED]: [
    status(
      'COURIER_RETURN',
      'New delivery assigned',
      () => `You have been assigned this delivery.`,
    ),
  ],
  [OrderStatus.RETURN_EN_ROUTE]: [
    status(
      'CUSTOMER',
      'Out for delivery',
      () => `Your laundry is on its way to you.`,
    ),
  ],
  [OrderStatus.DELIVERED_TO_CUSTOMER]: [
    status(
      'CUSTOMER',
      'Delivered',
      () => `Your laundry has been delivered. Thank you!`,
    ),
  ],
  [OrderStatus.DELIVERY_ATTEMPTED]: [
    action(
      'CUSTOMER',
      'Delivery could not be completed',
      () => `We could not deliver your laundry. Reschedule to continue.`,
    ),
  ],
  [OrderStatus.AWAITING_CUSTOMER_PICKUP]: [
    status(
      'CUSTOMER',
      'Ready for collection',
      (p) => `Your laundry is waiting for you at ${p}.`,
    ),
  ],

  // ── Money ─────────────────────────────────────────────────────────────────
  [OrderStatus.REFUNDED]: [
    status('CUSTOMER', 'Refund issued', () => `This order has been refunded.`),
    status('PROVIDER', 'Refund issued', () => `This order has been refunded.`),
  ],
};

/** Every status that notifies someone. Useful for tests and for auditing noise. */
export const NOTIFYING_STATUSES = Object.keys(
  ORDER_NOTIFICATIONS,
) as OrderStatus[];

export const ORDER_NOTIFICATION_CATEGORY = NotificationCategory.ORDER;
