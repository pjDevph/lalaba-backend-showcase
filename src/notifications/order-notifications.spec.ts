import {
  ORDER_NOTIFICATIONS,
  NOTIFYING_STATUSES,
  type OrderAudience,
} from './order-notifications';
import { NotificationType } from './notification.enums';
import { OrderStatus } from '../online-orders/schemas/order-status.enum';

describe('order notification table', () => {
  const all = Object.values(ORDER_NOTIFICATIONS).flat();

  // The property that actually matters is not "how many statuses are in the
  // table" but "how many times does ONE person get buzzed for ONE order". A
  // ratio against the status count would pass while a customer got eight
  // notifications in an afternoon.
  const countFor = (audience: OrderAudience, flow: OrderStatus[]) =>
    flow.reduce(
      (n, s) =>
        n +
        (ORDER_NOTIFICATIONS[s] ?? []).filter((x) => x.audience === audience)
          .length,
      0,
    );

  it('[HP] a customer is buzzed a handful of times on a full order, not constantly', () => {
    // The longest normal journey: provider collects, washes, delivers back.
    const happyPath = [
      OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
      OrderStatus.ACCEPTED_BY_PROVIDER,
      OrderStatus.PICKUP_ASSIGNED,
      OrderStatus.PICKUP_EN_ROUTE,
      OrderStatus.PICKUP_ARRIVED,
      OrderStatus.PICKUP_WEIGHED,
      OrderStatus.PICKED_UP_FROM_CUSTOMER,
      OrderStatus.RECEIVED_BY_PROVIDER,
      OrderStatus.LAUNDRY_IN_PROGRESS,
      OrderStatus.LAUNDRY_READY,
      OrderStatus.RETURN_ASSIGNED,
      OrderStatus.RETURN_EN_ROUTE,
      OrderStatus.RETURN_ARRIVED,
      OrderStatus.DELIVERED_TO_CUSTOMER,
      OrderStatus.COMPLETED,
    ];
    expect(countFor('CUSTOMER', happyPath)).toBeLessThanOrEqual(6);
    // And the provider, who is doing the work and watching the order anyway,
    // hears about it once: the booking landing.
    expect(countFor('PROVIDER', happyPath)).toBeLessThanOrEqual(1);
    // Each courier hears only about their own assignment.
    expect(countFor('COURIER_PICKUP', happyPath)).toBe(1);
    expect(countFor('COURIER_RETURN', happyPath)).toBe(1);
  });

  it('[HP] silent statuses stay silent', () => {
    // Internal steps the recipient either caused or cannot act on.
    for (const s of [
      OrderStatus.LAUNDRY_IN_PROGRESS,
      OrderStatus.PICKUP_ARRIVED,
      OrderStatus.RETURN_ARRIVED,
      OrderStatus.RECEIVED_BY_PROVIDER,
      OrderStatus.COMPLETED,
    ]) {
      expect(ORDER_NOTIFICATIONS[s]).toBeUndefined();
    }
  });

  it('[HP] every row has a title and a readable body', () => {
    for (const spec of all) {
      expect(spec.title.trim().length).toBeGreaterThan(0);
      expect(spec.body('WashWash Angono').trim().length).toBeGreaterThan(0);
    }
  });

  // The reference is metadata the client renders on its own line. Inlining it
  // made every row read like a receipt — "Order LB-000001 has been weighed"
  // rather than "Your laundry has been weighed".
  it('[HP] no body inlines an order reference', () => {
    for (const spec of all) {
      expect(spec.body('WashWash Angono')).not.toMatch(
        /LB-|order [A-Z0-9]{4,}/i,
      );
    }
  });

  it('[HP] only known audiences are used', () => {
    const known: OrderAudience[] = [
      'CUSTOMER',
      'PROVIDER',
      'COURIER_PICKUP',
      'COURIER_RETURN',
    ];
    for (const spec of all) expect(known).toContain(spec.audience);
  });

  // ACTION_NEEDED is what a client sorts and styles as urgent. Spending it on
  // rows that are merely informational is how the distinction stops meaning
  // anything.
  it('[SEC] ACTION_NEEDED is reserved for states that block the order', () => {
    const blocking = new Set<string>([
      OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
      OrderStatus.PROVIDER_CHANGE_PROPOSED,
      OrderStatus.PICKUP_ATTEMPT_FAILED,
      OrderStatus.LAUNDRY_QUALITY_HOLD,
      OrderStatus.AWAITING_RETURN_SELECTION,
      OrderStatus.DELIVERY_ATTEMPTED,
    ]);
    for (const [statusKey, specs] of Object.entries(ORDER_NOTIFICATIONS)) {
      for (const spec of specs ?? []) {
        if (spec.type === NotificationType.ORDER_ACTION_NEEDED) {
          expect(blocking.has(statusKey)).toBe(true);
        }
      }
    }
  });

  it('[HP] the customer is told the things they cannot see for themselves', () => {
    // Money becoming known, and the laundry moving to or from them.
    for (const s of [
      OrderStatus.PICKUP_WEIGHED,
      OrderStatus.LAUNDRY_READY,
      OrderStatus.RETURN_EN_ROUTE,
      OrderStatus.DELIVERED_TO_CUSTOMER,
    ]) {
      const specs = ORDER_NOTIFICATIONS[s] ?? [];
      expect(specs.some((x) => x.audience === 'CUSTOMER')).toBe(true);
    }
  });

  it('[HP] a new booking reaches the provider — nothing moves until they accept', () => {
    const specs =
      ORDER_NOTIFICATIONS[OrderStatus.PENDING_PROVIDER_ACCEPTANCE] ?? [];
    expect(specs.some((x) => x.audience === 'PROVIDER')).toBe(true);
  });

  it('[HP] couriers are told only about their own leg', () => {
    expect(
      (ORDER_NOTIFICATIONS[OrderStatus.PICKUP_ASSIGNED] ?? []).map(
        (x) => x.audience,
      ),
    ).toEqual(['COURIER_PICKUP']);
    expect(
      (ORDER_NOTIFICATIONS[OrderStatus.RETURN_ASSIGNED] ?? []).map(
        (x) => x.audience,
      ),
    ).toEqual(['COURIER_RETURN']);
  });

  it('[SEC] no status notifies the same audience twice', () => {
    for (const specs of Object.values(ORDER_NOTIFICATIONS)) {
      const seen = (specs ?? []).map((x) => x.audience);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('[SEC] every key is a real OrderStatus', () => {
    const valid = new Set<string>(Object.values(OrderStatus));
    for (const key of NOTIFYING_STATUSES) expect(valid.has(key)).toBe(true);
  });
});
