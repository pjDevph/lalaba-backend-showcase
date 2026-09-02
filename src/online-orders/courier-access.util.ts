import { OnlineOrder } from './schemas/online-order.schema';
import { OrderStatus } from './schemas/order-status.enum';

export type CourierLeg = 'pickup' | 'return';

// The window in which a courier is physically working a leg: from
// "Start navigation" (enRouteAt / *_EN_ROUTE) until the leg completes.
// Deliberately excludes *_ASSIGNED — the rider hasn't set off yet — and
// everything after handover.
const LIVE_STATUSES: Record<CourierLeg, ReadonlySet<OrderStatus>> = {
  pickup: new Set([
    OrderStatus.PICKUP_EN_ROUTE,
    OrderStatus.PICKUP_ARRIVED,
    // Weighed but payment not yet collected/deferred — the courier is still
    // standing at the door finishing the leg.
    OrderStatus.PICKUP_WEIGHED,
  ]),
  return: new Set([OrderStatus.RETURN_EN_ROUTE, OrderStatus.RETURN_ARRIVED]),
};

// The window in which a leg sits on a courier's task board: from assignment
// until handover. WIDER than LIVE_STATUSES above — it includes *_ASSIGNED,
// because a job you haven't set off on is still yours to see and start.
//
// Keep in sync with courierLegFor() in the merchant app
// (src/stores/onlineOrdersStore.ts): the server decides which orders reach the
// rider, the client decides which bucket they land in, and if the two disagree
// a task either vanishes from the board or arrives with no bucket to sit in.
export const ASSIGNED_STATUSES: Record<CourierLeg, readonly OrderStatus[]> = {
  pickup: [
    OrderStatus.PICKUP_ASSIGNED,
    OrderStatus.PICKUP_EN_ROUTE,
    OrderStatus.PICKUP_ARRIVED,
    OrderStatus.PICKUP_WEIGHED,
  ],
  return: [
    OrderStatus.RETURN_ASSIGNED,
    OrderStatus.RETURN_EN_ROUTE,
    OrderStatus.RETURN_ARRIVED,
  ],
};

/**
 * The leg `uid` is actively riding on this order, or null.
 *
 * Gates every courier-side capability that reaches the customer directly —
 * today the unmasked phone number and the courier↔customer chat thread. The
 * rules it encodes:
 *
 *  - Access starts at "Start navigation", not at assignment. A rider who has
 *    been given the job but hasn't set off has no reason to ring the customer.
 *  - Access ends the moment the leg completes ("the chat session expires when
 *    pickup is done and return is done").
 *  - It is checked per leg against that leg's own assignedStaffUid, so when a
 *    different rider handles the return they get their own window and the
 *    pickup rider does not inherit it.
 */
export function activeCourierLeg(
  order: Pick<OnlineOrder, 'status' | 'pickupAssignment' | 'returnAssignment'>,
  uid: string,
): CourierLeg | null {
  if (!uid) return null;
  const status = order.status;

  if (
    order.pickupAssignment?.assignedStaffUid === uid &&
    LIVE_STATUSES.pickup.has(status)
  ) {
    return 'pickup';
  }
  if (
    order.returnAssignment?.assignedStaffUid === uid &&
    LIVE_STATUSES.return.has(status)
  ) {
    return 'return';
  }
  return null;
}

/**
 * The leg `uid` holds the assignment on, or null. Deliberately status-blind:
 * once a leg is given to a rider it is theirs, before they set off and after
 * they hand over.
 *
 * This is the wider sibling of activeCourierLeg() and exists for exactly one
 * thing: the customer's location (see canSeeCustomerLocation in
 * online-orders.service.ts). A rider needs to see where a job is to plan and
 * accept it — under the live-leg window their unstarted stops had no
 * coordinates at all and simply vanished from the map.
 *
 * It is NOT a substitute for activeCourierLeg. The capabilities that reach the
 * customer directly — the unmasked phone, the chat thread — and the two other
 * precise-location controls (doorstep attempt GPS / SEC-001, access
 * instructions / SEC-010) stay on the narrow live-leg window.
 */
export function assignedCourierLeg(
  order: Pick<OnlineOrder, 'pickupAssignment' | 'returnAssignment'>,
  uid: string,
): CourierLeg | null {
  if (!uid) return null;
  if (order.pickupAssignment?.assignedStaffUid === uid) return 'pickup';
  if (order.returnAssignment?.assignedStaffUid === uid) return 'return';
  return null;
}
