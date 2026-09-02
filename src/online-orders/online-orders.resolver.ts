import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { OnlineOrdersService } from './online-orders.service';
import {
  OnlineOrder,
  OrderPricing,
  CustomerSnapshot,
  AttemptEvidence,
  OrderInstructions,
} from './schemas/online-order.schema';
import { OrderEvent } from './schemas/order-event.schema';
import { PaginatedOnlineOrders } from './models/paginated-online-orders.model';
import { AssignableCourier } from './models/assignable-courier.model';
import { AdminOrderFilterInput } from './dto/admin-order-filter.input';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';
import {
  FulfillmentReturnMode,
  PaymentTiming,
  PaymentStatus,
  LEGACY_PAYMENT_TIMING_ON_DELIVERY,
  CourierTaskScope,
  OrderStatus,
  OrderLeg,
} from './schemas/order-status.enum';
import { CreateOrderInput } from './dto/create-order.input';
import { QuoteOrderInput } from './dto/quote-order.input';
import {
  RejectOrderInput,
  ProposeOrderChangeInput,
  CancelOrderInput,
} from './dto/order-decision.input';
import { RecordCollectionInput } from './dto/record-collection.input';
import {
  RecordPickupWeightInput,
  RecordPickupPaymentInput,
} from './dto/record-pickup.input';
import { UpdateCourierLocationInput } from './dto/update-courier-location.input';
import { RecordAttemptInput } from './dto/record-attempt.input';
import {
  RaiseQualityHoldInput,
  RespondToQualityHoldInput,
} from './dto/quality-hold.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

// Staff included: they run the counter when the owner is not there, and an
// online queue only one person can open is a queue that stops at closing time.
// Which staff, and on which branch, is decided by their per-branch Orders grant
// and by assertBranchOwnership — not by this list.
const PROVIDER_ROLES = ['merchant', 'washer', 'staff'];
const COURIER_ROLES = ['courier', 'washer']; // a Home Washer may act as her own courier

@Resolver(() => OnlineOrder)
@UseGuards(GqlAuthGuard, RolesGuard)
export class OnlineOrdersResolver {
  constructor(
    private readonly ordersService: OnlineOrdersService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  // ---- Reads ----

  @Roles('customer')
  @Query(() => [OnlineOrder], { name: 'myOnlineOrders' })
  async myOnlineOrders(@CurrentUser() user: User): Promise<OnlineOrder[]> {
    return this.ordersService.myOrders(user._id);
  }

  @Query(() => OnlineOrder, { name: 'onlineOrder' })
  async onlineOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.order(id, user);
  }

  @Query(() => [OrderEvent], { name: 'onlineOrderTimeline' })
  async onlineOrderTimeline(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OrderEvent[]> {
    await this.ordersService.order(orderId, user); // authorizes
    return this.ordersService.orderTimeline(orderId);
  }

  @Roles(...PROVIDER_ROLES)
  @Query(() => [OnlineOrder], { name: 'incomingOnlineOrders' })
  async incomingOnlineOrders(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder[]> {
    return this.ordersService.incomingOrders(branchId, user);
  }

  // Who can I hand this delivery to?
  //
  // Providers AND staff — see assignableCouriers. This exists instead of
  // pointing the picker at `myStaff`, which lives on StaffResolver behind
  // owner-only roles and returns full staff records: staff on the counter need
  // to assign a courier without being able to read or manage the roster.
  @Roles(...PROVIDER_ROLES)
  @Query(() => [AssignableCourier], { name: 'assignableCouriers' })
  async assignableCouriers(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ): Promise<AssignableCourier[]> {
    return this.ordersService.assignableCouriers(branchId, user);
  }

  @Roles(...COURIER_ROLES)
  @Query(() => [OnlineOrder], { name: 'myAssignedOnlineOrders' })
  async myAssignedOnlineOrders(
    @CurrentUser() user: User,
    @Args('scope', {
      type: () => CourierTaskScope,
      nullable: true,
      defaultValue: CourierTaskScope.ALL,
    })
    scope: CourierTaskScope,
  ): Promise<OnlineOrder[]> {
    return this.ordersService.myAssignedTasks(user._id, scope);
  }

  @Roles('customer')
  @Query(() => OrderPricing, { name: 'quoteOnlineOrder' })
  async quoteOnlineOrder(
    @Args('input') input: QuoteOrderInput,
    @CurrentUser() user: User,
  ): Promise<OrderPricing> {
    return this.ordersService.quoteOrder(input, user._id);
  }

  // ---- Creation & provider decision ----

  @Roles('customer')
  @Mutation(() => OnlineOrder)
  async createOnlineOrder(
    @Args('input') input: CreateOrderInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.createOrder(user, input);
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async acceptOnlineOrder(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.acceptOrder(orderId, user);
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async rejectOnlineOrder(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RejectOrderInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.rejectOrder(orderId, user, input);
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async proposeOnlineOrderChange(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: ProposeOrderChangeInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.proposeOrderChange(orderId, user, input);
  }

  @Roles('customer')
  @Mutation(() => OnlineOrder)
  async respondToProviderChange(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('approve') approve: boolean,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.respondToProviderChange(orderId, user, approve);
  }

  @Roles('customer', ...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async cancelOnlineOrder(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: CancelOrderInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.cancelOrder(orderId, user, input);
  }

  // ---- Pickup ----

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async assignPickupStaff(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('staffUid') staffUid: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.assignPickupStaff(orderId, user, staffUid);
  }

  // Live GPS ping from the assigned courier (called on an interval while en
  // route). Location-only; does not advance the order status.
  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async updateCourierLocation(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: UpdateCourierLocationInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.updateCourierLocation(orderId, input, user);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async startPickupRoute(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.startPickupRoute(orderId, user);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async arriveAtPickup(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.arriveAtPickup(orderId, user);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async recordPickupWeight(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RecordPickupWeightInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.recordPickupWeight(orderId, user, input);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async recordPickupPayment(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RecordPickupPaymentInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.recordPickupPayment(orderId, user, input);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async recordFailedPickupAttempt(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RecordAttemptInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.recordFailedPickupAttempt(orderId, user, input);
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async retryPickupSameDay(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.retryPickupSameDay(orderId, user);
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async escalateToPickupReschedule(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.escalateToReschedule(orderId, user);
  }

  @Roles('customer')
  @Mutation(() => OnlineOrder)
  async reschedulePickup(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.reschedulePickup(orderId, user);
  }

  @Roles('customer')
  @Mutation(() => OnlineOrder)
  async cancelAfterFailedPickup(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.cancelAfterFailedPickup(orderId, user);
  }

  // ---- Drop-off ----

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async receiveOrderAtCounter(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RecordCollectionInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.receiveAtCounter(orderId, user, input);
  }

  // ---- Processing & quality holds ----

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async markLaundryReady(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.markLaundryReady(orderId, user);
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async raiseQualityHold(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RaiseQualityHoldInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.raiseQualityHold(orderId, user, input);
  }

  @Roles('customer')
  @Mutation(() => OnlineOrder)
  async respondToQualityHold(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RespondToQualityHoldInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.respondToQualityHold(orderId, user, input);
  }

  // ---- Return-mode exception ----

  @Roles('customer')
  @Mutation(() => OnlineOrder)
  async chooseReturnOption(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('returnMode', { type: () => FulfillmentReturnMode })
    returnMode: FulfillmentReturnMode,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.chooseReturnOption(orderId, user, returnMode);
  }

  // ---- Return delivery ----

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async assignReturnStaff(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('staffUid') staffUid: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.assignReturnStaff(orderId, user, staffUid);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async startReturnRoute(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.startReturnRoute(orderId, user);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async arriveAtReturn(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.arriveAtReturn(orderId, user);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async recordDelivery(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input', { type: () => RecordCollectionInput, nullable: true })
    input: RecordCollectionInput | undefined,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.recordDelivery(orderId, user, input);
  }

  @Roles(...COURIER_ROLES)
  @Mutation(() => OnlineOrder)
  async recordFailedDeliveryAttempt(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input') input: RecordAttemptInput,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.recordFailedDeliveryAttempt(orderId, user, input);
  }

  /**
   * Uploads one handover proof frame and returns its storage key, which the
   * caller then passes to recordPickupWeight / recordDelivery via proofObjectKeys.
   *
   * Separate from the collection mutation on purpose: collection runs inside a
   * Mongo transaction, and a mobile photo upload is far too slow to hold one
   * open. Couriers are included here — they are the ones at the door — which is
   * why this cannot reuse uploadMedia (public bucket, provider roles only).
   */
  @Roles(...COURIER_ROLES, ...PROVIDER_ROLES, 'staff')
  @Mutation(() => String)
  async uploadHandoverProof(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('leg', { type: () => OrderLeg }) leg: OrderLeg,
    @Args('base64') base64: string,
    @Args('mimeType') mimeType: string,
    @CurrentUser() user: User,
  ): Promise<string> {
    return this.ordersService.uploadHandoverProof(
      orderId,
      leg === OrderLeg.PICKUP ? 'pickup' : 'return',
      base64,
      mimeType,
      user,
    );
  }

  /**
   * Signed, short-lived URLs for the pickup handover photos. Empty for anyone
   * who isn't the customer, the provider or the courier who captured them —
   * these frames show a private address.
   */
  @ResolveField(() => [String], { name: 'pickupProofUrls' })
  async pickupProofUrls(
    @Parent() order: OnlineOrder,
    @CurrentUser() user: User,
  ): Promise<string[]> {
    return this.ordersService.handoverProofUrls(order, 'pickup', user);
  }

  @ResolveField(() => [String], { name: 'returnProofUrls' })
  async returnProofUrls(
    @Parent() order: OnlineOrder,
    @CurrentUser() user: User,
  ): Promise<string[]> {
    return this.ordersService.handoverProofUrls(order, 'return', user);
  }

  /**
   * Platform-wide order search — the way support actually finds an order.
   *
   * `onlineOrder(id)` needs an exact 24-character ObjectId, and the product
   * has no short order number anywhere, so before this an agent taking a call
   * could not look up the order being complained about at all. One search box
   * resolves an order id, a party uid, a phone number (matched against the
   * USER record, since the order stores only a masked one) or a name.
   */
  @Roles('admin', 'support')
  @Query(() => PaginatedOnlineOrders, { name: 'adminOrders' })
  async adminOrders(
    @Args('filter', { nullable: true }) filter?: AdminOrderFilterInput,
  ): Promise<PaginatedOnlineOrders> {
    return this.ordersService.adminSearchOrders(filter ?? {});
  }

  /**
   * Support's unpaid-money queue: everything still owing plus everything
   * already written off. Platform-wide, so admin/support only.
   */
  @Roles('admin', 'support')
  @Query(() => PaginatedOnlineOrders, { name: 'unsettledOrders' })
  async unsettledOrders(
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<PaginatedOnlineOrders> {
    return this.ordersService.unsettledOrders(limit ?? 50, offset ?? 0);
  }

  /**
   * The states this order may legally be moved to right now.
   *
   * The override control is populated FROM this — a free-text status field, or
   * a list of all 33 states, is how an order ends up in a state its own
   * lifecycle cannot explain.
   */
  @Roles('admin', 'support')
  @Query(() => [OrderStatus], { name: 'orderStatusOptions' })
  async orderStatusOptions(
    @Args('orderId', { type: () => ID }) orderId: string,
  ): Promise<OrderStatus[]> {
    return this.ordersService.allowedNextStatuses(orderId);
  }

  /**
   * Move an order by hand when the app that should have done it did not.
   *
   * Validated against the same transition table as every automatic move, so
   * this advances the lifecycle rather than overriding it. `note` is required:
   * an unexplained manual move makes the order's history unreadable later.
   */
  @Roles('admin', 'support')
  @Mutation(() => OnlineOrder)
  async overrideOrderStatus(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('status', { type: () => OrderStatus }) status: OrderStatus,
    @Args('reason') reason: string,
    @Args('note') note: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    const order = await this.ordersService.overrideStatus(
      orderId,
      status,
      user,
      `[${reason}] ${note}`,
    );
    await this.adminAudit.record({
      action: AdminAuditAction.ORDER_STATUS_OVERRIDDEN,
      actor: user,
      targetType: AdminAuditTargetType.ORDER,
      targetId: orderId,
      targetLabel: order.customer.displayName,
      reasonCode: reason,
      note,
      details: { to: status },
    });
    return order;
  }

  /**
   * Support escape hatch for an abandoned order whose customer turned up late
   * with the money. Admin/support only — the whole point of the abandoned state
   * is that neither the provider nor the courier can quietly restart delivery
   * on an order nobody paid for.
   */
  @Roles('admin', 'support')
  @Mutation(() => OnlineOrder)
  async reinstateAbandonedOrder(
    @Args('orderId', { type: () => ID }) orderId: string,
    // Explicit () => String: a `string | undefined` union has no reflectable
    // design type, so the implicit form fails at schema-BUILD time — which
    // typecheck and unit tests both sail past, and only booting the app catches.
    @Args('note', { type: () => String, nullable: true })
    note: string | undefined,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    const order = await this.ordersService.reinstateAbandonedOrder(
      orderId,
      user,
      note,
    );
    await this.adminAudit.record({
      action: AdminAuditAction.ORDER_REINSTATED,
      actor: user,
      targetType: AdminAuditTargetType.ORDER,
      targetId: orderId,
      targetLabel: order.customer.displayName,
      note,
      details: { reinstatedTo: order.status },
    });
    return order;
  }

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async confirmReturnedToProvider(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.confirmReturnedToProvider(orderId, user);
  }

  @Roles('customer', ...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async scheduleRedelivery(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.scheduleRedelivery(orderId, user);
  }

  // ---- Self-pickup ----

  @Roles(...PROVIDER_ROLES)
  @Mutation(() => OnlineOrder)
  async verifySelfPickup(
    @Args('orderId', { type: () => ID }) orderId: string,
    @Args('input', { type: () => RecordCollectionInput, nullable: true })
    input: RecordCollectionInput | undefined,
    @CurrentUser() user: User,
  ): Promise<OnlineOrder> {
    return this.ordersService.verifySelfPickup(orderId, user, input);
  }

  // ---- Computed fields ----

  // Resolved payment state for customer + provider/rider UI. Derived from
  // paymentTiming/paymentSummary/pricing rather than stored, so it's always
  // consistent with the underlying numbers.
  // The customer's dialable number, for the rider currently working a leg —
  // null for everyone else and outside that window. Kept as a resolved field
  // rather than part of the stored snapshot so it can be permission-checked per
  // request; the snapshot itself only ever holds the masked form.
  @ResolveField(() => String, { name: 'contactPhone', nullable: true })
  async contactPhone(
    @Parent() order: OnlineOrder,
    @CurrentUser() user: User,
  ): Promise<string | null> {
    return this.ordersService.contactPhoneFor(order, user._id);
  }

  // The Verified badge for the provider on order details. Resolved live rather
  // than read off the stored ProviderSnapshot, so it always agrees with the
  // provider's profile — see OnlineOrdersService.isProviderVerified.
  @ResolveField(() => Boolean, { name: 'providerVerified' })
  async providerVerified(@Parent() order: OnlineOrder): Promise<boolean> {
    return this.ordersService.isProviderVerified(order);
  }

  // Note UNPAID now covers two situations: a deferred order legitimately in
  // flight with nothing due yet, and a pay-now order that somehow never
  // collected. Clients tell them apart with paymentTiming, which is why that
  // field had to stop lying about legacy orders (see below). Anything alerting
  // on "UNPAID past pickup" needs a paymentTiming !== AT_FINAL_HANDOVER guard.
  @ResolveField(() => PaymentStatus, { name: 'paymentStatus' })
  paymentStatus(@Parent() order: OnlineOrder): PaymentStatus {
    const collected = order.paymentSummary?.amountCollectedCentavos ?? null;
    const due = order.pricing?.customerTotalCentavos ?? null;
    if (collected == null) return PaymentStatus.UNPAID;
    // Something was collected — check it actually covers what's owed now (a
    // quality-hold surcharge approved after collection can leave a shortfall).
    if (due != null && collected < due) return PaymentStatus.BALANCE_DUE;
    return PaymentStatus.PAID;
  }

  /**
   * What the customer still owes right now. Saves every client re-deriving the
   * same subtraction: the courier's "collect ₱X" prompt at handover, the
   * surcharge balance on a BALANCE_DUE order, and the customer's Pay Later
   * banner all read this one number.
   */
  @ResolveField(() => Int, { name: 'amountDueCentavos' })
  amountDueCentavos(@Parent() order: OnlineOrder): number {
    const due = order.pricing?.customerTotalCentavos ?? 0;
    const collected = order.paymentSummary?.amountCollectedCentavos ?? 0;
    return Math.max(0, due - collected);
  }

  // Legacy-read tolerance: pre-hardening dev orders may still store
  // 'on_delivery', which no longer serializes. It means precisely what
  // AT_FINAL_HANDOVER means, so that is what it maps to — mapping it to
  // ON_PICKUP (as it did while pay-on-delivery didn't exist) would now tell a
  // customer their uncollected order was paid at pickup. No write path accepts
  // the legacy value; scripts/migrations rewrites it.
  @ResolveField(() => PaymentTiming, { name: 'paymentTiming' })
  paymentTiming(@Parent() order: OnlineOrder): PaymentTiming {
    return (order.paymentTiming as string) === LEGACY_PAYMENT_TIMING_ON_DELIVERY
      ? PaymentTiming.AT_FINAL_HANDOVER
      : order.paymentTiming;
  }

  // Privacy-gated customer snapshot (RISK-P0-009): exact address/coords and
  // maskedPhone resolve per requester — a courier sees them on the legs
  // ASSIGNED to them (they have to be able to find and plan the job) and on
  // nothing else. The unmasked phone is separate and stays on the narrower
  // live-leg window. The generalized areaLabel is always present so list
  // screens still render a location for everyone else.
  @ResolveField(() => CustomerSnapshot, { name: 'customer' })
  customer(
    @Parent() order: OnlineOrder,
    @CurrentUser() user: User,
  ): CustomerSnapshot {
    return this.ordersService.customerSnapshotFor(order, user);
  }

  // SEC-001: attempt evidence carries the doorstep gpsLat/gpsLng captured when
  // a rider fails a pickup/delivery — house-level coordinates for the
  // customer's home. These were plain fields with no resolver, so any courier
  // who could see the order could read them outside their own leg, defeating
  // the redaction on `customer`. Same active-leg authorization applies here.
  @ResolveField(() => [AttemptEvidence], { name: 'pickupAttempts' })
  pickupAttempts(
    @Parent() order: OnlineOrder,
    @CurrentUser() user: User,
  ): AttemptEvidence[] {
    return this.ordersService.attemptsFor(order.pickupAttempts, order, user);
  }

  @ResolveField(() => [AttemptEvidence], { name: 'deliveryAttempts' })
  deliveryAttempts(
    @Parent() order: OnlineOrder,
    @CurrentUser() user: User,
  ): AttemptEvidence[] {
    return this.ordersService.attemptsFor(order.deliveryAttempts, order, user);
  }

  // SEC-010: accessInstructions is free text where customers put gate codes,
  // unit numbers and door instructions — as identifying as the address, and
  // never redacted. Gated on the same window; the other instruction fields
  // (pickup/return/laundry-care) stay visible because the job needs them.
  @ResolveField(() => OrderInstructions, { name: 'instructions' })
  instructions(
    @Parent() order: OnlineOrder,
    @CurrentUser() user: User,
  ): OrderInstructions {
    return this.ordersService.instructionsFor(order, user);
  }
}
