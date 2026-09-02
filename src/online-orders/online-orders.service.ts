import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  ClientSession,
  Connection,
  Model,
  isValidObjectId,
  type QueryFilter,
} from 'mongoose';
import { AdminOrderFilterInput } from './dto/admin-order-filter.input';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from './schemas/online-order.schema';
import { OrderEvent, OrderEventDocument } from './schemas/order-event.schema';
import {
  OnlineTransaction,
  OnlineTransactionDocument,
  OnlineTransactionStatus,
} from './schemas/online-transaction.schema';
import { AssignableCourier } from './models/assignable-courier.model';
import {
  chargeablePlatformFeeCentavos,
  waivablePlatformFeeCentavos,
} from './platform-fee-parts.util';
import {
  OrderStatus,
  ProviderType,
  TurnaroundTierCode,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  PaymentMethod,
  PaymentTiming,
  LEGACY_PAYMENT_TIMING_ON_DELIVERY,
  CourierTaskScope,
  assertValidTransition,
  ORDER_STATUS_TRANSITIONS,
  CAP_COUNTED_STATUSES,
} from './schemas/order-status.enum';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ORDER_NOTIFICATIONS,
  ORDER_NOTIFICATION_CATEGORY,
  type OrderAudience,
} from '../notifications/order-notifications';
import {
  DailyCapCounter,
  DailyCapCounterDocument,
} from './schemas/daily-cap-counter.schema';
import { QualityHoldResponse } from './schemas/online-order.schema';
import { Address, AddressDocument } from '../addresses/schemas/address.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import {
  Service,
  ServiceDocument,
  PricingType,
} from '../services/schemas/service.schema';
import {
  WasherServiceTemplate,
  WasherServiceTemplateDocument,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Inventory,
  InventoryDocument,
} from '../inventory/schemas/inventory.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  activeCourierLeg,
  assignedCourierLeg,
  ASSIGNED_STATUSES,
} from './courier-access.util';
import { Role } from '../users/schemas/role.schema';
import { CreateOrderInput } from './dto/create-order.input';
import { QuoteOrderInput } from './dto/quote-order.input';
import {
  OrderPricing,
  CustomerSnapshot,
  AttemptEvidence,
  OrderInstructions,
} from './schemas/online-order.schema';
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
import { RecordAttemptInput } from './dto/record-attempt.input';
import { UpdateCourierLocationInput } from './dto/update-courier-location.input';
import {
  RaiseQualityHoldInput,
  RespondToQualityHoldInput,
} from './dto/quality-hold.input';
import { WasherServiceOfferingsService } from '../washer-service-offerings/washer-service-offerings.service';
import {
  assertQuantityWithinOfferingLimits,
  resolveWasherPricing,
} from '../washer-service-offerings/washer-pricing.util';
import {
  calculateServiceLineTotal,
  calculatePlatformFee,
  roundCentavos,
} from './pricing.util';
import {
  STORAGE_PROVIDER,
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
} from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';
import { WalletsService } from '../wallets/wallets.service';
import { WalletAcceptanceGuardService } from '../wallets/wallet-acceptance-guard.service';
import { PlatformFeeService } from '../platform-fee/platform-fee.service';
import { ProviderEligibilityService } from './provider-eligibility.service';
import { BookingAvailabilityService } from '../booking-availability/booking-availability.service';
import { PromotionsService } from '../promotions/promotions.service';
import {
  PRICING_RULE_VERSION,
  resolveFulfillmentFees,
  resolveTurnaround,
} from './fulfillment-pricing.util';

// There is deliberately NO default daily order cap.
//
// `WasherProfile.maxOrdersPerDay` is Admin's per-washer number
// (setWasherDailyOrderCap), and null means she has none — the checks below skip
// entirely rather than substituting a constant. The local `20` that used to
// live here had no owner and no UI: it outranked the admin-configurable
// BookingPolicy capacity the booking engine enforces (seeded at 3) and the
// figure the washer app showed her, so all three disagreed.
const PH_OFFSET_MS = 8 * 3600 * 1000;

// `startOfTodayPH()` lived here and had one caller: the washer cap, counting
// orders by the day they were CREATED. Now that the cap counts the day the
// laundry is scheduled for, nothing needs a "start of today" instant — a day
// KEY compares directly against the stored date string.

/** PH-local calendar day key, e.g. '2026-08-12'. */
function phDayKey(): string {
  return new Date(Date.now() + PH_OFFSET_MS).toISOString().slice(0, 10);
}

// The two resting states where the provider is holding finished laundry that
// the customer has not paid for and not taken: waiting to pick a redelivery,
// and waiting for a self-pickup that may never come. Nowhere else can a
// deferred order sit indefinitely, so nowhere else needs a clock.
// The Philippines is UTC+8 year-round with no DST, so the offset is a
// constant rather than something needing a timezone library.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight in Manila on the calendar day the given instant falls in. */
function manilaDayStart(value: Date | string): Date {
  const instant = new Date(value).getTime() + MANILA_OFFSET_MS;
  return new Date(instant - (instant % DAY_MS) - MANILA_OFFSET_MS);
}

/** The last millisecond of that same Manila day. */
function manilaDayEnd(value: Date | string): Date {
  return new Date(manilaDayStart(value).getTime() + DAY_MS - 1);
}

// Admin search terms go into a RegExp — escape them so a stray "(" is a
// literal rather than a syntax error, and a ".*" can't be used to force a
// collection scan.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ABANDONMENT_WAITING_STATES: OrderStatus[] = [
  OrderStatus.AWAITING_REDELIVERY_SELECTION,
  OrderStatus.AWAITING_CUSTOMER_PICKUP,
];

// The payment-side fields shared by RecordCollectionInput (drop-off/return
// leg) and RecordPickupPaymentInput (pickup leg, split from RecordCollection
// so recordCollectionTransaction/resolvePickupPaymentTiming can serve both
// without depending on either concrete DTO.
type PaymentCollectionFields = Pick<
  RecordCollectionInput,
  'paymentTiming' | 'paymentMethod' | 'referenceId' | 'tenderedCentavos'
>;
// How long an unsettled order waits before the sweep gives up on it. Long
// enough to survive a holiday weekend, short enough that a provider isn't
// storing someone else's laundry for a month. Self-pickup relies on this
// entirely — there is no failed-attempt path to shorten it.
const ABANDONMENT_WINDOW_HOURS = 7 * 24;

@Injectable()
export class OnlineOrdersService {
  private readonly logger = new Logger(OnlineOrdersService.name);

  constructor(
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(OrderEvent.name)
    private readonly eventModel: Model<OrderEventDocument>,
    @InjectModel(OnlineTransaction.name)
    private readonly transactionModel: Model<OnlineTransactionDocument>,
    @InjectModel(Address.name)
    private readonly addressModel: Model<AddressDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerProfileModel: Model<WasherProfileDocument>,
    @InjectModel(Service.name)
    private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(WasherServiceTemplate.name)
    private readonly templateModel: Model<WasherServiceTemplateDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Inventory.name)
    private readonly inventoryModel: Model<InventoryDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(DailyCapCounter.name)
    private readonly capCounterModel: Model<DailyCapCounterDocument>,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly walletsService: WalletsService,
    private readonly walletAcceptanceGuard: WalletAcceptanceGuardService,
    private readonly providerEligibility: ProviderEligibilityService,
    private readonly platformFeeService: PlatformFeeService,
    private readonly washerOfferingsService: WasherServiceOfferingsService,
    private readonly bookingAvailability: BookingAvailabilityService,
    private readonly promotionsService: PromotionsService,
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private roleIdOf(user: User): string {
    return (user.role as unknown as Role)?.roleId ?? 'unknown';
  }

  /** Mirrors SupportTicketsService.nextTicketNumber — same counter shape, "LB-" prefix. */
  private async nextOrderNumber(): Promise<string> {
    const count = await this.orderModel.estimatedDocumentCount().exec();
    return `LB-${String(count + 1).padStart(6, '0')}`;
  }

  private async findOrderOrThrow(
    orderId: string,
  ): Promise<OnlineOrderDocument> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * May this actor work this branch's online orders?
   *
   * The owner, or a STAFF member of the owner's tenant who is assigned to the
   * branch. Staff used to fail here unconditionally — it compared branch.uid to
   * the caller's own uid — so a shop's staff saw an empty Online Orders screen
   * while the owner, on the same branch, saw the queue. A merchant who has gone
   * home cannot be the only person able to accept a booking.
   *
   * Assignment, not merely tenancy: being employed by the business does not
   * make someone able to act on every branch of it.
   *
   * NOTE: this checks branch ASSIGNMENT, not the branch their device is pinned
   * to. A staff member assigned to two branches could act on either by naming
   * it. Tightening that means threading the active branch through seventeen
   * call sites; the permission guard already applies the correct per-branch
   * grant to every action that carries @RequirePermissions.
   */
  private async assertBranchOwnership(
    branchId: string,
    actor: User,
  ): Promise<void> {
    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch) throw new ForbiddenException('You do not manage this branch');

    if (branch.uid === actor._id) return;

    const roleId = (actor.role as unknown as Role)?.roleId;
    const assigned = (actor.branchIds ?? []).map(String);
    if (
      roleId === 'staff' &&
      actor.merchantId === branch.uid &&
      assigned.includes(String(branchId))
    ) {
      return;
    }

    throw new ForbiddenException('You do not manage this branch');
  }

  /** Applies a status transition, writes the append-only event, and bumps
   * the optimistic-concurrency version — the one place every mutation below
   * routes through, so no transition can skip validation or go unrecorded. */
  private async applyTransition(
    order: OnlineOrderDocument,
    to: OrderStatus,
    actorUid: string,
    actorRole: string,
    session: ClientSession,
    note?: string,
  ): Promise<void> {
    assertValidTransition(order.status, to);
    const expectedVersion = order.version;
    const from = order.status;
    order.status = to;
    order.version = expectedVersion + 1;

    // The express SLA clock starts when the provider physically has the
    // laundry. Stamped here rather than in recordPickup/receiveAtCounter
    // because both inbound paths funnel through this one transition, so the
    // promise cannot depend on which way the laundry arrived. Written once —
    // a re-entry (e.g. back from a quality hold) must not extend the deadline.
    const patch: Record<string, unknown> = {
      status: to,
      version: expectedVersion + 1,
    };
    if (
      to === OrderStatus.LAUNDRY_IN_PROGRESS &&
      order.turnaround?.tierCode === TurnaroundTierCode.EXPRESS &&
      order.turnaround.slaHours &&
      !order.turnaround.promisedCompletionAt
    ) {
      const promisedAt = new Date(
        Date.now() + order.turnaround.slaHours * 60 * 60 * 1000,
      );
      order.turnaround.promisedCompletionAt = promisedAt;
      patch['turnaround.promisedCompletionAt'] = promisedAt;
    }

    // The abandonment clock. Runs only in the two resting states where the
    // provider still physically holds finished laundry and the customer still
    // owes for it. Unlike the SLA promise above this IS re-stamped on every
    // entry, so each redelivery cycle gets a fresh window instead of inheriting
    // an already-expired one; and it clears on the way out, so an order that
    // gets moving again isn't swept later.
    if (ABANDONMENT_WAITING_STATES.includes(to)) {
      const deadline =
        this.outstandingCentavos(order) > 0
          ? new Date(Date.now() + ABANDONMENT_WINDOW_HOURS * 60 * 60 * 1000)
          : null;
      order.abandonmentDeadlineAt = deadline;
      patch['abandonmentDeadlineAt'] = deadline;
    } else if (order.abandonmentDeadlineAt != null) {
      order.abandonmentDeadlineAt = null;
      patch['abandonmentDeadlineAt'] = null;
    }

    const updateResult = await this.orderModel.updateOne(
      { _id: order._id, version: expectedVersion },
      { $set: patch },
      { session },
    );
    if (updateResult.matchedCount === 0) {
      throw new BadRequestException(
        'Order was modified concurrently — please retry',
      );
    }

    const lastEvent = await this.eventModel
      .findOne({ orderId: String(order._id) })
      .sort({ sequence: -1 })
      .session(session)
      .exec();
    await this.eventModel.create(
      [
        {
          orderId: String(order._id),
          sequence: (lastEvent?.sequence ?? 0) + 1,
          fromStatus: from,
          toStatus: to,
          actorUid,
          actorRole,
          note: note ?? undefined,
        },
      ],
      { session },
    );

    await this.settlePromoForTransition(order, to, session);

    this.notifyForTransition(order, to);
  }

  /**
   * Move any promo slot this order is holding, in step with the order itself.
   *
   * Here rather than at the individual call sites because this is the one
   * place every transition passes through — a release that lived in
   * `cancelOrder` would be missed by the abandonment sweep, the admin
   * override, and whatever cancels an order next.
   *
   * Inside the caller's transaction, so a rolled-back transition cannot leave
   * a released slot behind. Both operations only touch RESERVED rows, so a
   * retried transition is a no-op rather than a double-release.
   *
   * Statuses that are neither of these leave the slot RESERVED — including
   * ABANDONED_UNSETTLED, where the provider did the work and the customer
   * simply never paid. Holding the slot is the safe direction: it keeps the
   * cap consumed rather than handing back a code for an order that really did
   * consume capacity.
   */
  private async settlePromoForTransition(
    order: OnlineOrderDocument,
    to: OrderStatus,
    session: ClientSession,
  ): Promise<void> {
    // Guarded on promoCode, not promoId: the code is part of the pricing
    // snapshot written inside the order's own transaction, while promoId is
    // stamped afterwards from the reservation. A hook that depended on the
    // later write would miss any order whose reservation failed — exactly the
    // orders whose slot most needs settling correctly.
    // Either kind of promotion — a customer's code, or a partner's fee waiver.
    // releaseForOrder/settleForOrder work by order id and move every reserved
    // row, so an order carrying both is handled in one call.
    if (!order.pricing?.promoCode && !order.pricing?.platformFeePromoId) return;
    const orderId = String(order._id);

    if (
      to === OrderStatus.REJECTED_BY_PROVIDER ||
      to === OrderStatus.CANCELLED
    ) {
      await this.promotionsService.releaseForOrder(orderId, session);
      return;
    }
    if (to === OrderStatus.COMPLETED) {
      await this.promotionsService.settleForOrder(orderId, session);
    }
  }

  /**
   * Tell whoever needs to know that this order moved.
   *
   * Fire-and-forget, and deliberately so: a notification must never fail an
   * order transition or slow the write path. The cost is that a transaction
   * which later rolls back — only possible here on an optimistic-concurrency
   * clash, which throws and is retried — can leave a notification for a
   * transition that did not stick. Rare, and preferable to threading a
   * post-commit flush through 24 call sites; revisit if it ever bites.
   *
   * Which statuses notify whom lives in ORDER_NOTIFICATIONS, not here.
   */
  private notifyForTransition(
    order: OnlineOrderDocument,
    to: OrderStatus,
  ): void {
    const specs = ORDER_NOTIFICATIONS[to];
    if (!specs?.length) return;

    // Only used as the reference CLIENTS display; the body no longer inlines it.
    const ref = order.orderNumber || String(order._id).slice(-6).toUpperCase();
    const providerName = order.provider?.providerName || 'Your provider';

    for (const spec of specs) {
      const uid = this.audienceUid(order, spec.audience);
      if (!uid) continue;

      void this.notifications.notify(
        { uid },
        {
          type: spec.type,
          category: ORDER_NOTIFICATION_CATEGORY,
          title: spec.title,
          body: spec.body(providerName),
          data: {
            orderId: String(order._id),
            orderNumber: order.orderNumber ?? ref,
            status: to,
            branchId: order.provider?.branchId ?? null,
          },
        },
      );
    }
  }

  /** Resolve a table audience to the uid it means on THIS order. */
  private audienceUid(
    order: OnlineOrderDocument,
    audience: OrderAudience,
  ): string | null {
    switch (audience) {
      case 'CUSTOMER':
        return order.customer?.uid ?? null;
      case 'PROVIDER':
        return order.provider?.providerUid ?? null;
      case 'COURIER_PICKUP':
        return order.pickupAssignment?.assignedStaffUid ?? null;
      case 'COURIER_RETURN':
        return order.returnAssignment?.assignedStaffUid ?? null;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  async createOrder(
    customer: User,
    input: CreateOrderInput,
  ): Promise<OnlineOrder> {
    const address = await this.addressModel.findById(input.addressId).exec();
    if (!address || address.uid !== customer._id || address.isArchived) {
      throw new BadRequestException('Address not found');
    }

    // Central bookability gate (GAP-P0-006) — existence, operational state,
    // payment-readiness, washer service radius vs this address.
    const { branch, washer, providerName, providerUid } =
      await this.providerEligibility.assertProviderBookable(
        input.providerType,
        input.branchId,
        {
          stage: 'create',
          customerLat: address.mapLocation?.latitude,
          customerLng: address.mapLocation?.longitude,
        },
      );

    if (input.providerType === ProviderType.WASHER && washer) {
      // Booking-time cap check (§13) — the acceptance-time re-check in
      // acceptOrder() is the real atomic guard; this is just UX.
      await this.assertWasherUnderDailyCap(
        washer,
        input.branchId,
        input.scheduledPickup?.date ?? phDayKey(),
      );
    }

    const serviceLines = await Promise.all(
      input.serviceLines.map((line) =>
        this.buildServiceLineSnapshot(
          input.providerType,
          line,
          input.branchId,
          washer,
        ),
      ),
    );

    const estimatedServiceSubtotalCentavos = serviceLines.reduce(
      (sum, l) => sum + l.estimatedLineTotalCentavos,
      0,
    );
    // Snapshotted now so a later admin rate change never rewrites this
    // order's math (§16). Fee is shown to the customer on top of the
    // service price, not absorbed by the provider. The rate is the one
    // configured for THIS provider type — washers and merchants can be on
    // different commissions.
    const commission = await this.platformFeeService.resolveCommissionSnapshot(
      input.providerType,
    );
    const platformFeePercent = commission.percent;
    const estimatedFeeCentavos = calculatePlatformFee(
      estimatedServiceSubtotalCentavos,
      platformFeePercent,
    );
    // Server-authoritative fulfillment fees (GAP-P0-005), snapshotted so a
    // later change to the provider's prices — or to the platform ceiling —
    // never rewrites this order's math.
    const fulfillmentPricing =
      await this.bookingAvailability.fulfillmentPricingFor(input.branchId);
    const { pickupFeeCentavos, returnFeeCentavos } = resolveFulfillmentFees({
      pickupMode: input.pickupMode,
      pickupSubMode: input.pickupSubMode,
      returnMode: input.returnMode,
      deliverySubMode: input.deliverySubMode,
      config: fulfillmentPricing.config,
      ceilingCentavos: fulfillmentPricing.ceilingCentavos,
    });
    // Express is a laundromat product. A home washer is one person with one
    // machine, so a priority queue she cannot actually jump is a promise the
    // platform would be making on her behalf. Gated here rather than only
    // hidden in the customer app, so the rule survives a stale client.
    //
    // Note this is a check on PRIORITY, not on pickup pricing: express stays
    // separate from pickupSubMode (FREE_BATCH / SCHEDULED_PAID), which is
    // about transport. A merchant can be both express and free-batch.
    if (
      input.turnaroundTier === TurnaroundTierCode.EXPRESS &&
      input.providerType !== ProviderType.MERCHANT
    ) {
      throw new BadRequestException(
        'Express turnaround is only available from laundry shops.',
      );
    }

    // Speed is priced separately from transport: an express order pays the
    // turnaround fee whether it is delivered or collected.
    const turnaround = resolveTurnaround(
      input.turnaroundTier,
      fulfillmentPricing.config,
      fulfillmentPricing.ceilingCentavos,
    );
    const preDiscountTotalCentavos =
      estimatedServiceSubtotalCentavos +
      estimatedFeeCentavos +
      pickupFeeCentavos +
      returnFeeCentavos +
      turnaround.feeCentavos;

    // Unlike quoteOrder's silent-ignore, an invalid/expired/ineligible code
    // here IS rejected — the customer is actually placing the order, and a
    // code that priced the review screen must not silently stop applying at
    // the last step. Re-validated and actually redeemed (with the real
    // orderId) once the order itself has been saved below, rather than
    // trusted from whatever a prior quoteOrder call said.
    let discountCentavos = 0;
    const trimmedPromoCode = input.promoCode?.trim();
    if (trimmedPromoCode) {
      const check = await this.promotionsService.validate(
        trimmedPromoCode,
        customer._id,
        preDiscountTotalCentavos,
      );
      if (!check.valid) {
        throw new BadRequestException(
          check.reason ?? 'Promo code is not valid',
        );
      }
      discountCentavos = check.discountCentavos;
    }
    const estimatedTotalCentavos = preDiscountTotalCentavos - discountCentavos;

    const doc = new this.orderModel({
      customer: {
        uid: customer._id,
        displayName: `${customer.firstName} ${customer.lastName}`,
        maskedPhone: maskPhone(customer.phoneNumber),
        address: address.address,
        mapLocation: address.mapLocation,
        areaLabel: areaLabelOf(address.address),
      },
      provider: {
        providerType: input.providerType,
        providerUid,
        branchId: input.branchId,
        providerName,
        // Snapshotted like every other term of the order: whether this shop was
        // offering pay-at-handover when the customer booked.
        allowsPayAtHandover: branch.allowsPayAtHandover ?? false,
      },
      serviceLines,
      instructions: input.instructions ?? {},
      fulfillment: {
        pickupMode: input.pickupMode,
        pickupSubMode: input.pickupSubMode ?? null,
        returnMode: input.returnMode,
        deliverySubMode: input.deliverySubMode ?? null,
        // Filled in inside the transaction below, once the slot has been
        // validated and reserved — see the booking-availability call.
        scheduledPickup: null,
      },
      paymentTiming: input.paymentTiming ?? PaymentTiming.ON_PICKUP,
      pricing: {
        estimatedTotalCentavos,
        platformFeePercent,
        platformFeeCentavos: estimatedFeeCentavos,
        feeRuleKey: commission.ruleKey,
        feeRuleVersion: commission.ruleVersion,
        serviceSubtotalCentavos: estimatedServiceSubtotalCentavos,
        pickupFeeCentavos,
        returnFeeCentavos,
        turnaroundFeeCentavos: turnaround.feeCentavos,
        pricingRuleVersion: PRICING_RULE_VERSION,
        promoCode: trimmedPromoCode
          ? trimmedPromoCode.toUpperCase()
          : undefined,
        discountCentavos: discountCentavos || undefined,
      },
      turnaround: {
        tierCode: turnaround.tierCode,
        feeCentavos: turnaround.feeCentavos,
        slaHours: turnaround.slaHours,
        // Stamped when the provider actually has the laundry, not now.
        promisedCompletionAt: null,
      },
      status: OrderStatus.DRAFT,
      version: 0,
    });

    // Every order carries a pickup DATE. It used to be conditional on the
    // provider's `requireScheduledPickup` flag, which meant a provider could
    // take orders that occupied no date — and day capacity is counted by
    // grouping on exactly that field, so those orders consumed the provider's
    // real day while counting toward nothing. There is no time to choose any
    // more, so requiring the date costs the customer one tap and makes the
    // daily cap enforceable for everyone.
    if (!input.scheduledPickup) {
      throw new BadRequestException('Please choose a pickup date.');
    }

    // The outbound leg gets its own capability check. The inbound leg is
    // validated inside assertSlotBookable against the chosen date, but the
    // return window is never scheduled (§11), so there is no date to check —
    // only whether this provider delivers at all. Without this a provider who
    // has switched delivery off still receives PROVIDER_DELIVERY orders and
    // finds out at markLaundryReady that she cannot fulfil them.
    if (input.returnMode === FulfillmentReturnMode.PROVIDER_DELIVERY) {
      const delivers = await this.bookingAvailability.offersProviderDelivery(
        input.branchId,
        input.providerType,
      );
      if (!delivers) {
        throw new BadRequestException(
          'This provider does not deliver — choose to collect your laundry instead.',
        );
      }
    }

    const session = await this.connection.startSession();
    let saved: OnlineOrderDocument;
    try {
      await session.withTransaction(async () => {
        // Inside the transaction so the capacity read and the day reservation
        // commit together — two customers racing for the last place in a day
        // write-conflict on the counter and one is retried, rather than both
        // reading "4 of 5 booked" and both committing.
        const booked = await this.bookingAvailability.assertDayBookable(
          input.branchId,
          input.providerType,
          input.scheduledPickup,
          input.pickupMode === FulfillmentPickupMode.CUSTOMER_DROPOFF
            ? 'dropoff'
            : 'pickup',
          session,
        );
        doc.fulfillment.scheduledPickup = booked;

        // Retry on the unique-index collision two concurrent creates would
        // cause — same bounded pattern as SupportTicketsService.create().
        // Regenerating and re-saving rather than retrying the whole
        // transaction: the booking-availability reservation above already
        // succeeded and must not be redone.
        for (let attempt = 0; attempt < 5; attempt++) {
          doc.orderNumber = await this.nextOrderNumber();
          try {
            saved = await doc.save({ session });
            break;
          } catch (err) {
            const isDuplicateOrderNumber =
              (err as { code?: number })?.code === 11000 &&
              /orderNumber/.test((err as Error)?.message ?? '');
            if (!isDuplicateOrderNumber || attempt === 4) throw err;
          }
        }
        await this.eventModel.create(
          [
            {
              orderId: String(saved._id),
              sequence: 1,
              toStatus: OrderStatus.DRAFT,
              actorUid: customer._id,
              actorRole: 'customer',
            },
          ],
          { session },
        );
        // No payment gateway step exists pre-acceptance under cash-basis
        // payment (§14) — estimate is validated and the order goes straight
        // to pending_provider_acceptance in the same call.
        await this.applyTransition(
          saved,
          OrderStatus.PRICING_VALIDATED,
          customer._id,
          'customer',
          session,
        );
        await this.applyTransition(
          saved,
          OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
          customer._id,
          'customer',
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    // Committed in its own transaction, after the order's — PromotionsService
    // owns redemption atomicity (usage-cap race, ledger insert) and doesn't
    // accept an external session. Re-validates from scratch rather than
    // trusting discountCentavos computed a moment ago above, matching every
    // other caller of redeem(). The order itself is not rolled back if this
    // unexpectedly fails (e.g. the code was deactivated in the instant
    // between): the customer already has a saved order at the discounted
    // price, and reverting a real, already-placed order over a bookkeeping
    // race would be worse than a missed redemption-ledger row. Logged loudly
    // instead, same convention as AdminAuditService.record.
    if (trimmedPromoCode) {
      try {
        const reserved = await this.promotionsService.reserve({
          code: trimmedPromoCode,
          customerUid: customer._id,
          orderTotalCentavos: preDiscountTotalCentavos,
          orderId: String(saved!._id),
        });
        // `promoId` has been on the schema and in the SDL since promos landed
        // and was never actually written — every order reported null. Nothing
        // read it, so nothing noticed, and the first thing to guard on it
        // (this lifecycle's release hook) silently did nothing. Populate it
        // now that a consumer exists.
        saved!.pricing.promoId = String(reserved.promoId);
        saved!.markModified('pricing');
        await saved!.save();
      } catch (err) {
        this.logger.error(
          `Order ${saved!._id} was created with promo ${trimmedPromoCode} applied, but redemption failed to record: ${(err as Error)?.message}`,
          (err as Error)?.stack,
        );
      }
    }

    return saved!;
  }

  // Pricing-only preview — never persists. Reuses the exact same line-snapshot
  // and fee math as createOrder(), so the quoted estimate equals the order the
  // customer will place. Powers the booking-footer estimate + Review (§16).
  async quoteOrder(
    input: QuoteOrderInput,
    customerUid: string,
  ): Promise<OrderPricing> {
    // Same central gate as createOrder (GAP-P0-006) — a quote for an
    // unbookable provider is a lie the booking step would later contradict.
    const { washer } = await this.providerEligibility.assertProviderBookable(
      input.providerType,
      input.branchId,
      { stage: 'quote' },
    );

    const serviceLines = await Promise.all(
      input.serviceLines.map((line) =>
        this.buildServiceLineSnapshot(
          input.providerType,
          line,
          input.branchId,
          washer,
        ),
      ),
    );
    const estimatedServiceSubtotalCentavos = serviceLines.reduce(
      (sum, l) => sum + l.estimatedLineTotalCentavos,
      0,
    );
    // Same per-provider-type rate the order will be created at, so the quote
    // and the placed order agree.
    const commission = await this.platformFeeService.resolveCommissionSnapshot(
      input.providerType,
    );
    const platformFeePercent = commission.percent;
    const estimatedFeeCentavos = calculatePlatformFee(
      estimatedServiceSubtotalCentavos,
      platformFeePercent,
    );
    // Fulfillment fees (GAP-P0-005) — same formula createOrder snapshots, so
    // the quoted total equals the order the customer will place.
    const quotePricing = await this.bookingAvailability.fulfillmentPricingFor(
      input.branchId,
    );
    const { pickupFeeCentavos, returnFeeCentavos } = resolveFulfillmentFees({
      pickupMode: input.pickupMode,
      pickupSubMode: input.pickupSubMode,
      returnMode: input.returnMode,
      deliverySubMode: input.deliverySubMode,
      config: quotePricing.config,
      ceilingCentavos: quotePricing.ceilingCentavos,
    });
    const quoteTurnaround = resolveTurnaround(
      input.turnaroundTier,
      quotePricing.config,
      quotePricing.ceilingCentavos,
    );
    const customerTotalCentavos =
      quoteTurnaround.feeCentavos +
      estimatedServiceSubtotalCentavos +
      estimatedFeeCentavos +
      pickupFeeCentavos +
      returnFeeCentavos;

    const estimatedWeightKg = input.serviceLines.reduce(
      (sum, l) => sum + (l.estimatedWeightKg ?? 0),
      0,
    );

    // Preview only — never redeemed here. An invalid/expired/ineligible code
    // is silently ignored (no discount, no error) rather than failing the
    // whole quote: the customer hasn't committed to anything yet, and
    // createOrder is the one place a bad code actually blocks booking.
    let discountCentavos = 0;
    let appliedPromoCode: string | null = null;
    if (input.promoCode?.trim()) {
      const check = await this.promotionsService.validate(
        input.promoCode.trim(),
        customerUid,
        customerTotalCentavos,
      );
      if (check.valid) {
        discountCentavos = check.discountCentavos;
        appliedPromoCode = input.promoCode.trim().toUpperCase();
      }
    }
    const discountedTotalCentavos = customerTotalCentavos - discountCentavos;

    return {
      estimatedWeightKg: estimatedWeightKg || undefined,
      estimatedTotalCentavos: discountedTotalCentavos,
      platformFeePercent,
      platformFeeCentavos: estimatedFeeCentavos,
      feeRuleKey: commission.ruleKey,
      feeRuleVersion: commission.ruleVersion,
      serviceSubtotalCentavos: estimatedServiceSubtotalCentavos,
      pickupFeeCentavos,
      returnFeeCentavos,
      turnaroundFeeCentavos: quoteTurnaround.feeCentavos,
      customerTotalCentavos: discountedTotalCentavos,
      promoCode: appliedPromoCode,
      discountCentavos: discountCentavos || undefined,
      pricingRuleVersion: PRICING_RULE_VERSION,
    };
  }

  /**
   * Builds one priced service-line snapshot, tenant-scoped (RISK-P0-007):
   * merchant services must belong to the order's branch, washer templates
   * must be in the washer's offered set, and replacement products must be
   * active products of that same branch — foreign or missing IDs are
   * rejected, never silently priced.
   */
  private async buildServiceLineSnapshot(
    providerType: ProviderType,
    line: {
      serviceRefId: string;
      estimatedWeightKg?: number;
      estimatedPieceCount?: number;
      note?: string;
      replacementProductIds?: string[];
    },
    branchId: string,
    washer?: WasherProfileDocument,
  ) {
    let serviceName: string;
    // Typed, not `any` (GAP-TYPE-002). The loose type here is what disabled
    // the exhaustiveness check in calculateServiceLineTotal, so an unknown
    // pricing model could reach the money calculation and price at zero.
    let pricingType: PricingType;
    let price: number;
    let baseKilos: number | undefined;
    let excessRate: number | undefined;
    let minBillableKg: number | undefined;

    if (providerType === ProviderType.WASHER) {
      const offered = (washer?.offeredServiceTemplateIds ?? []).map(String);
      if (!offered.includes(String(line.serviceRefId))) {
        throw new BadRequestException(
          'This washer does not offer the selected service',
        );
      }
      const template = await this.templateModel
        .findById(line.serviceRefId)
        .exec();
      if (!template || !template.isActive) {
        throw new BadRequestException('Service template not found or inactive');
      }
      serviceName = template.name;
      // The washer's own price when she has set one, the platform default when
      // she hasn't — resolved through the same helper discovery uses, so the
      // quote can never disagree with the price the customer browsed.
      const resolved = resolveWasherPricing(
        template,
        await this.washerOfferingsService.findOne(
          branchId,
          String(template._id),
        ),
      );
      pricingType = resolved.pricingType;
      price = resolved.price;
      baseKilos = resolved.baseKilos;
      excessRate = resolved.excessRate;
      minBillableKg = resolved.minBillableKg;
      assertQuantityWithinOfferingLimits(
        resolved,
        line.estimatedPieceCount,
        serviceName,
      );
    } else {
      const service = await this.serviceModel
        .findOne({ _id: line.serviceRefId, branchId } as any)
        .exec();
      // isActive is deliberately NOT checked here — it gates POS only, so a
      // service paused in POS can still be booked online, and vice versa.
      if (!service || service.isArchived || !service.isOnline) {
        throw new BadRequestException(
          'Service not found for this provider or inactive',
        );
      }
      serviceName = service.serviceName;
      pricingType = service.pricingType;
      price = service.price;
      baseKilos = service.baseKilos ?? undefined;
      excessRate = service.excessRate ?? undefined;
    }

    let productSurchargeCentavos = 0;
    if (line.replacementProductIds?.length) {
      const requestedIds = [...new Set(line.replacementProductIds.map(String))];
      const products = await this.productModel
        .find({
          _id: { $in: requestedIds },
          isActive: true,
          isArchived: { $ne: true },
        } as any)
        .exec();
      // Products anchor to a branch through their Inventory row — verify every
      // requested product's inventory belongs to THIS provider's branch.
      const inventories = await this.inventoryModel
        .find({
          _id: { $in: products.map((p) => p.inventoryId) },
          branchId,
        } as any)
        .select('_id')
        .exec();
      const branchInventoryIds = new Set(inventories.map((i) => String(i._id)));
      const allOwned =
        products.length === requestedIds.length &&
        products.every((p) => branchInventoryIds.has(String(p.inventoryId)));
      if (!allOwned) {
        throw new BadRequestException(
          'One or more replacement products are not available from this provider',
        );
      }
      productSurchargeCentavos = products.reduce((sum, p) => sum + p.price, 0);
    }

    const estimatedLineTotalCentavos =
      calculateServiceLineTotal(
        { pricingType, price, baseKilos, excessRate, minBillableKg },
        line.estimatedWeightKg ?? null,
        line.estimatedPieceCount ?? null,
      ) + productSurchargeCentavos;

    return {
      serviceRefId: line.serviceRefId,
      serviceName,
      pricingType,
      price,
      baseKilos,
      excessRate,
      minBillableKg,
      productSurchargeCentavos,
      estimatedLineTotalCentavos,
      estimatedPieceCount: line.estimatedPieceCount,
      note: line.note?.trim() || undefined,
    };
  }

  /** Booking-time cap check — advisory UX only; the atomic reservation in
   * reserveDailyCapSlot() at acceptance time is the real guard (GAP-H-013).
   *
   * No admin-set cap ⇒ nothing to check here. Her bookable slots are still
   * bounded by the platform booking policy, which the availability engine
   * enforces on the same request (assertSlotBookable). */
  private async assertWasherUnderDailyCap(
    washerProfile: WasherProfileDocument,
    branchId: string,
    scheduledDay: string,
  ): Promise<void> {
    const cap = washerProfile.maxOrdersPerDay;
    if (cap == null) return;
    // Same basis as the acceptance-time reservation below — a pre-flight check
    // measuring a different day than the guard it precedes would reject
    // bookings the guard would have allowed, and vice versa.
    const count = await this.orderModel.countDocuments({
      'provider.branchId': branchId,
      'fulfillment.scheduledPickup.date': scheduledDay,
      status: { $in: CAP_COUNTED_STATUSES },
    });
    if (count >= cap) {
      throw new BadRequestException(
        scheduledDay === phDayKey()
          ? 'This washer has reached her order limit for today'
          : `This washer is fully booked on ${scheduledDay}`,
      );
    }
  }

  /**
   * Acceptance-time atomic cap reservation (GAP-H-013). MUST run inside the
   * acceptance transaction. Serializes concurrent accepts by $inc-ing one
   * shared per-branch/per-day counter doc (concurrent transactions touching
   * it write-conflict; the loser retries and re-counts with the winner's
   * accept visible), then recounts the REAL slot consumers — orders created
   * today in an accepted-or-beyond, non-voided state — excluding the order
   * being accepted so it never counts against itself.
   */
  private async reserveDailyCapSlot(
    order: OnlineOrderDocument,
    washerProfile: WasherProfileDocument,
    session: ClientSession,
  ): Promise<void> {
    const branchId = order.provider.branchId;
    // No admin-set cap ⇒ no slot to reserve, and nothing to serialize against.
    // The counter doc exists only to make concurrent accepts conflict under a
    // cap; without one there is no limit for two accepts to race past.
    const cap = washerProfile.maxOrdersPerDay;
    if (cap == null) return;

    // Counted against the day the laundry is SCHEDULED for, not the day the
    // order happened to be created or accepted.
    //
    // It used to key on the order's creation date, which made this cap
    // disagree with the availability engine's `dailyBookingLimit` — that one
    // has always grouped on `fulfillment.scheduledPickup.date`. Two caps
    // counting different things about the same washer produced two wrong
    // answers: accepting an order booked for NEXT week consumed today's slot,
    // while an order booked for today but created yesterday consumed nothing.
    // A washer could be told she was full on a day with no work on it.
    //
    // Orders with no scheduled date fall back to today, which is what an
    // unscheduled order effectively is.
    const scheduledDay = order.fulfillment?.scheduledPickup?.date ?? phDayKey();

    await this.capCounterModel
      .findOneAndUpdate(
        { branchId, dayKey: scheduledDay },
        { $inc: { acceptedCount: 1 } },
        { upsert: true, new: true, session },
      )
      .exec();
    const accepted = await this.orderModel
      .countDocuments({
        'provider.branchId': branchId,
        _id: { $ne: order._id },
        'fulfillment.scheduledPickup.date': scheduledDay,
        status: { $in: CAP_COUNTED_STATUSES },
      })
      .session(session);
    if (accepted >= cap) {
      throw new BadRequestException(
        scheduledDay === phDayKey()
          ? 'This washer has reached her order limit for today'
          : `This washer is fully booked on ${scheduledDay}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Provider decision
  // -------------------------------------------------------------------------

  async acceptOrder(orderId: string, actor: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);

    // Central eligibility (GAP-P0-006) — a provider who has gone
    // inactive/offline since booking can't accept.
    const { washer } = await this.providerEligibility.assertProviderBookable(
      order.provider.providerType,
      order.provider.branchId,
      { stage: 'accept' },
    );

    // Shared wallet acceptance gate (GAP-P0-004) — BOTH provider types. A
    // washer's wallet is her anchor branch's wallet (order.provider.branchId
    // is that anchor for washers), so one branchId-keyed check covers both.
    await this.walletAcceptanceGuard.assertCanAcceptOrder(
      order.provider.branchId,
      order.pricing.platformFeeCentavos ?? 0,
    );

    if (order.provider.providerType === ProviderType.WASHER && washer) {
      // Ensure the day's cap counter doc exists BEFORE the transaction so the
      // in-transaction $inc conflicts cleanly instead of racing an upsert.
      await this.capCounterModel
        .updateOne(
          { branchId: order.provider.branchId, dayKey: phDayKey() },
          { $setOnInsert: { acceptedCount: 0 } },
          { upsert: true },
        )
        .exec();
    }

    // withTransaction may legitimately retry the callback (e.g. after the
    // cap-counter write conflict that serializes concurrent accepts) — reset
    // the in-memory status/version each attempt or the retry would see the
    // first attempt's already-bumped values and spuriously report a conflict.
    const initialStatus = order.status;
    const initialVersion = order.version;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        order.status = initialStatus;
        order.version = initialVersion;
        if (order.provider.providerType === ProviderType.WASHER && washer) {
          // Acceptance-time atomic cap reservation — the real guard against
          // two near-simultaneous accepts both slipping through (GAP-H-013).
          await this.reserveDailyCapSlot(order, washer, session);
        }
        await this.applyTransition(
          order,
          OrderStatus.ACCEPTED_BY_PROVIDER,
          actor._id,
          this.roleIdOf(actor),
          session,
        );
        await this.applyPlatformFeePromo(order, actor, session);
        // Auto-route: provider_pickup orders move straight into the
        // assignment queue; customer_dropoff orders just wait at
        // accepted_by_provider until receiveAtCounter() is called.
        if (
          order.fulfillment.pickupMode === FulfillmentPickupMode.PROVIDER_PICKUP
        ) {
          await this.applyTransition(
            order,
            OrderStatus.AWAITING_PICKUP_ASSIGNMENT,
            actor._id,
            this.roleIdOf(actor),
            session,
          );
        }
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  async rejectOrder(
    orderId: string,
    actor: User,
    input: RejectOrderInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    order.rejectionReason = input.reason;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        await this.applyTransition(
          order,
          OrderStatus.REJECTED_BY_PROVIDER,
          actor._id,
          this.roleIdOf(actor),
          session,
          input.reason,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  async proposeOrderChange(
    orderId: string,
    actor: User,
    input: ProposeOrderChangeInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    if (input.revisedEstimatedTotalCentavos !== undefined) {
      order.pricing.estimatedTotalCentavos =
        input.revisedEstimatedTotalCentavos;
    }
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        await this.applyTransition(
          order,
          OrderStatus.PROVIDER_CHANGE_PROPOSED,
          actor._id,
          this.roleIdOf(actor),
          session,
          input.reason,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  async respondToProviderChange(
    orderId: string,
    customer: User,
    approve: boolean,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.customer.uid !== customer._id) {
      throw new ForbiddenException('Not your order');
    }
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (approve) {
          await this.applyTransition(
            order,
            OrderStatus.ACCEPTED_BY_PROVIDER,
            customer._id,
            'customer',
            session,
          );
          if (
            order.fulfillment.pickupMode ===
            FulfillmentPickupMode.PROVIDER_PICKUP
          ) {
            await this.applyTransition(
              order,
              OrderStatus.AWAITING_PICKUP_ASSIGNMENT,
              customer._id,
              'customer',
              session,
            );
          }
        } else {
          await this.applyTransition(
            order,
            OrderStatus.CANCELLED,
            customer._id,
            'customer',
            session,
            'Customer declined proposed change',
          );
        }
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  async cancelOrder(
    orderId: string,
    actor: User,
    input: CancelOrderInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    const isCustomer = order.customer.uid === actor._id;
    if (!isCustomer) {
      await this.assertBranchOwnership(order.provider.branchId, actor);
    }
    order.cancellationReason = input.reason;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        await this.applyTransition(
          order,
          OrderStatus.CANCELLED,
          actor._id,
          this.roleIdOf(actor),
          session,
          input.reason,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  // -------------------------------------------------------------------------
  // Pickup (provider_pickup path)
  // -------------------------------------------------------------------------

  /**
   * Cross-tenant courier assignment guard (RISK-P0-008). A uid may be written
   * as a leg's courier only when it is (a) the provider owner herself — the
   * washer self-delivery case — or (b) an active, non-archived user whose role
   * is courier AND who belongs to this order's merchant/branch. Anything else
   * is rejected with a ForbiddenException, after an audit row is appended to
   * the order's event history.
   */
  /**
   * The couriers who may be given a leg of this branch's orders.
   *
   * Uses the SAME predicate as assertAssignableCourier, and that is the point:
   * the picker used to be filled from `myStaff` — every staff member the OWNER
   * employs, narrowed to couriers client-side and by nothing else. So it listed
   * couriers with no verified selfie and couriers attached to other branches,
   * all of whom the assign mutation then refused. A chooser that offers options
   * the next step rejects is worse than one that offers none.
   *
   * Staff may call this. Handing a delivery to a courier is counter work; it
   * implies none of the staff management the StaffResolver holds.
   */
  async assignableCouriers(
    branchId: string,
    actor: User,
  ): Promise<AssignableCourier[]> {
    await this.assertBranchOwnership(branchId, actor);

    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch) return [];

    const candidates = await this.userModel
      .find({
        isActive: true,
        isArchived: { $ne: true },
        selfieStatus: 'ACTIVE',
        $or: [{ merchantId: branch.uid }, { branchIds: branchId }],
      })
      .populate('role')
      .exec();

    return candidates
      .filter((u) => this.roleIdOf(u) === 'courier')
      .map((u) => ({
        _id: String(u._id),
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
      }));
  }

  private async assertAssignableCourier(
    order: OnlineOrderDocument,
    staffUid: string,
    actor: User,
  ): Promise<void> {
    // Washer self-delivery: the provider owner may courier her own order.
    if (
      order.provider.providerType === ProviderType.WASHER &&
      staffUid === order.provider.providerUid
    ) {
      return;
    }
    const reject = async (reason: string): Promise<never> => {
      await this.appendAuditEvent(
        order,
        actor,
        `Courier assignment rejected — ${reason} (staffUid=${staffUid})`,
      );
      throw new ForbiddenException(
        'This staff member cannot be assigned to deliveries for this order',
      );
    };
    const staff = await this.userModel
      .findById(staffUid)
      .populate('role')
      .exec();
    if (!staff || !staff.isActive || staff.isArchived) {
      return reject('staff user not found, inactive, or archived');
    }
    const roleId = this.roleIdOf(staff);
    if (roleId !== 'courier') {
      return reject(`user role '${roleId}' is not courier`);
    }
    // A courier without a live liveness selfie cannot be given work. GqlAuthGuard
    // already blocks them from acting, but that only fires once they try — this
    // stops the assignment from being made at all, so an owner finds out now
    // rather than watching a leg sit undeliverable.
    if (staff.selfieStatus !== 'ACTIVE') {
      return reject(
        `courier has no verified selfie (status=${staff.selfieStatus ?? 'none'})`,
      );
    }
    const branch = await this.branchModel
      .findById(order.provider.branchId)
      .exec();
    const ownerUid = branch?.uid;
    const memberBranchIds = (staff.branchIds ?? []).map(String);
    const sameTenant =
      (ownerUid != null && staff.merchantId === ownerUid) ||
      memberBranchIds.includes(String(order.provider.branchId));
    if (!sameTenant) {
      return reject('courier belongs to a different merchant/branch');
    }
  }

  /** Append-only audit row that records a material event WITHOUT a status
   * transition (fromStatus == toStatus). Best-effort — used before throwing. */
  private async appendAuditEvent(
    order: OnlineOrderDocument,
    actor: User,
    note: string,
  ): Promise<void> {
    const lastEvent = await this.eventModel
      .findOne({ orderId: String(order._id) })
      .sort({ sequence: -1 })
      .exec();
    await this.eventModel.create({
      orderId: String(order._id),
      sequence: (lastEvent?.sequence ?? 0) + 1,
      fromStatus: order.status,
      toStatus: order.status,
      actorUid: actor._id,
      actorRole: this.roleIdOf(actor),
      note,
    });
  }

  async assignPickupStaff(
    orderId: string,
    actor: User,
    staffUid: string,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    await this.assertAssignableCourier(order, staffUid, actor);
    order.pickupAssignment = {
      assignedStaffUid: staffUid,
      assignedAt: new Date(),
    };
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        await this.applyTransition(
          order,
          OrderStatus.PICKUP_ASSIGNED,
          actor._id,
          this.roleIdOf(actor),
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  private assertAssignedCourier(
    order: OnlineOrderDocument,
    leg: 'pickup' | 'return',
    actorUid: string,
  ) {
    const assignment =
      leg === 'pickup' ? order.pickupAssignment : order.returnAssignment;
    if (!assignment || assignment.assignedStaffUid !== actorUid) {
      throw new ForbiddenException('You are not assigned to this leg');
    }
  }

  // Reject fixes worse than this (metres) and faster than this (m/s ≈ 162 km/h,
  // impossible for a local courier — indicates a GPS jump or spoof).
  private static readonly MAX_ACCURACY_M = 80;
  private static readonly MAX_SPEED_MPS = 45;

  // Great-circle distance in metres (Haversine).
  private distanceMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Live GPS ping from the assigned courier while a leg is in progress. Validated
  // (spec §3): out-of-order (sequence/recordedAt), poor accuracy, and impossible
  // travel speed / jumps are REJECTED — the marker never moves backward or teleports.
  // Rejection is silent (returns the order unchanged) so the courier's stream is
  // not disrupted. Location-only — does NOT touch the status state machine.
  async updateCourierLocation(
    orderId: string,
    input: UpdateCourierLocationInput,
    courier: User,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    const ownsPickup =
      order.pickupAssignment?.assignedStaffUid === courier._id &&
      !order.pickupAssignment?.completedAt;
    const ownsReturn =
      order.returnAssignment?.assignedStaffUid === courier._id &&
      !order.returnAssignment?.completedAt;
    const legKey = ownsPickup
      ? 'pickupAssignment'
      : ownsReturn
        ? 'returnAssignment'
        : null;
    if (!legKey) {
      throw new ForbiddenException('No active leg assigned to you');
    }
    const a = order[legKey]!;
    const nextAt = new Date(input.recordedAt);

    // ── Reject stale / out-of-order / low-quality / impossible fixes ──────────
    if (a.locationSequence != null && input.sequence <= a.locationSequence)
      return order;
    if (a.locationAt && nextAt.getTime() <= a.locationAt.getTime())
      return order;
    if (
      input.accuracy != null &&
      input.accuracy > OnlineOrdersService.MAX_ACCURACY_M
    )
      return order;
    if (a.locationLat != null && a.locationLng != null && a.locationAt) {
      const meters = this.distanceMeters(
        a.locationLat,
        a.locationLng,
        input.latitude,
        input.longitude,
      );
      const dtSec = Math.max(
        (nextAt.getTime() - a.locationAt.getTime()) / 1000,
        0.001,
      );
      if (meters / dtSec > OnlineOrdersService.MAX_SPEED_MPS) return order;
    }

    // ── Accept ────────────────────────────────────────────────────────────────
    a.locationLat = input.latitude;
    a.locationLng = input.longitude;
    a.locationAt = nextAt;
    a.locationAccuracy = input.accuracy ?? undefined;
    a.locationSpeed = input.speed ?? undefined;
    a.locationHeading = input.heading ?? undefined;
    a.locationSequence = input.sequence;
    order.markModified(legKey); // Object-typed sub-doc — force change detection
    await order.save();
    return order;
  }

  async startPickupRoute(orderId: string, courier: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'pickup', courier._id);
    order.pickupAssignment!.enRouteAt = new Date();
    return this.saveAndTransition(order, OrderStatus.PICKUP_EN_ROUTE, courier);
  }

  async arriveAtPickup(orderId: string, courier: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'pickup', courier._id);
    order.pickupAssignment!.arrivedAt = new Date();
    return this.saveAndTransition(order, OrderStatus.PICKUP_ARRIVED, courier);
  }

  /**
   * Step 1/2 of the split pickup flow (§11/§14, split 2026-08-18 so the
   * customer can see the confirmed weight/total before the courier collects
   * payment — was previously the first half of one atomic recordPickup).
   * Weighs/counts and ALWAYS finalizes pricing (the customer needs the real
   * total right away), then parks the order at PICKUP_WEIGHED to await
   * recordPickupPayment.
   *
   * The platform fee is consumed from the provider's wallet here, not in the
   * payment step: it's owed once the order is fulfilled, independent of
   * payment timing, so it must not wait on whichever payment path the
   * customer picks next (immediate or deferred to final handover).
   */
  async recordPickupWeight(
    orderId: string,
    courier: User,
    input: RecordPickupWeightInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'pickup', courier._id);
    this.finalizePricing(
      order,
      input.actualWeightKg,
      input.actualPieceCount,
      input.lineActuals,
    );
    this.applyHandoverProof(
      order,
      'pickup',
      input.proofObjectKeys,
      courier._id,
    );

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        await this.consumeOutstandingFee(order, session);
        await this.applyTransition(
          order,
          OrderStatus.PICKUP_WEIGHED,
          courier._id,
          this.roleIdOf(courier),
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  /**
   * Step 2/2 of the split pickup flow. Only valid from PICKUP_WEIGHED
   * (enforced the same way every other transition here is — assertValidTransition
   * inside applyTransition, which aborts the whole DB transaction on an
   * invalid `from` status, so a courier can never collect before pricing is
   * finalized). Collects payment unless the customer defers to final
   * handover, which only providers who opted in may offer, then advances the
   * order through the same PICKED_UP_FROM_CUSTOMER → LAUNDRY_IN_PROGRESS
   * auto-advance chain the old atomic recordPickup used to run.
   */
  async recordPickupPayment(
    orderId: string,
    courier: User,
    input: RecordPickupPaymentInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'pickup', courier._id);
    order.pickupAssignment!.completedAt = new Date();
    order.markModified('pickupAssignment'); // Object-typed sub-doc — force change detection
    order.paymentTiming = this.resolvePickupPaymentTiming(order, input);
    const collectNow = order.paymentTiming === PaymentTiming.ON_PICKUP;

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        if (collectNow) {
          await this.recordCollectionTransaction(
            order,
            courier,
            input,
            session,
            {
              amountCentavos: this.outstandingCentavos(order),
              status: OnlineTransactionStatus.COMPLETED,
            },
          );
        }
        await this.applyTransition(
          order,
          OrderStatus.PICKED_UP_FROM_CUSTOMER,
          courier._id,
          this.roleIdOf(courier),
          session,
        );
        await this.applyTransition(
          order,
          OrderStatus.LAUNDRY_IN_PROGRESS,
          courier._id,
          this.roleIdOf(courier),
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  private finalizePricing(
    order: OnlineOrderDocument,
    actualWeightKg?: number,
    actualPieceCount?: number,
    lineActuals?: {
      serviceRefId: string;
      actualWeightKg?: number;
      actualPieceCount?: number;
    }[],
  ): void {
    // Per-line measured quantities take precedence (so a multi-service order can
    // mix per-kilo + per-piece lines); the order-level values are a fallback.
    const byRef = new Map(
      (lineActuals ?? []).map((la) => [la.serviceRefId, la]),
    );
    let serviceTotal = 0;
    let sumWeightKg = 0;
    let sumPieces = 0;
    let anyWeight = false;
    let anyPieces = false;
    for (const line of order.serviceLines) {
      const la = byRef.get(line.serviceRefId);
      const w = la?.actualWeightKg ?? actualWeightKg ?? null;
      const p = la?.actualPieceCount ?? actualPieceCount ?? null;
      const lineTotal =
        calculateServiceLineTotal(line, w, p) + line.productSurchargeCentavos;
      line.actualLineTotalCentavos = lineTotal;
      serviceTotal += lineTotal;
      // Track the quantity relevant to each line's pricing type, for the
      // order-level actual weight/pieces shown on proofs.
      const weighed =
        line.pricingType === PricingType.PER_KILO ||
        line.pricingType === PricingType.PER_KILO_WITH_BASE;
      if (weighed && w != null) {
        sumWeightKg += w;
        anyWeight = true;
      }
      if (line.pricingType === PricingType.PER_PIECE && p != null) {
        sumPieces += p;
        anyPieces = true;
      }
    }
    order.pricing.actualWeightKg = anyWeight
      ? sumWeightKg
      : (actualWeightKg ?? undefined);
    order.pricing.actualPieceCount = anyPieces
      ? sumPieces
      : (actualPieceCount ?? undefined);
    order.pricing.actualServiceTotalCentavos = serviceTotal;
    // Actual fee (§16-18) uses the rate snapshotted at booking, not
    // whatever the admin-configured rate is now.
    const actualFeeCentavos = calculatePlatformFee(
      serviceTotal,
      order.pricing.platformFeePercent ?? 0,
    );
    order.pricing.platformFeeCentavos = actualFeeCentavos;
    // A waiver follows the fee it waives. The customer estimated 5 kg and
    // brought 8 — nothing went wrong, so "no platform fee on this order" still
    // means no platform fee. Recomputed rather than frozen at acceptance,
    // which would quietly bill the provider for ordinary weight variance.
    // waivable() excludes any quality surcharge, so a penalty stays payable.
    if (order.pricing.platformFeePromoId) {
      order.pricing.platformFeeDiscountCentavos = waivablePlatformFeeCentavos(
        order.pricing,
      );
    }
    // Fulfillment fees were snapshotted at create (GAP-P0-005) and are part
    // of what the customer owes — the collected total must include them.
    order.pricing.customerTotalCentavos =
      serviceTotal +
      actualFeeCentavos +
      (order.pricing.pickupFeeCentavos ?? 0) +
      (order.pricing.returnFeeCentavos ?? 0) +
      // Re-added like the leg fees: the weigh-in re-prices the SERVICE, not the
      // extras. Omitting it would silently refund the express fee at pickup.
      (order.pricing.turnaroundFeeCentavos ?? 0);
    // NOTE: paymentSummary.amountCollectedCentavos is intentionally NOT set
    // here — pricing being finalized does not mean payment was collected
    // (pay-on-delivery orders finalize the price at pickup but collect later).
    // Only recordCollectionTransaction (the actual collection event) sets it.
    // pricing/serviceLines are Object-typed (Mixed) — Mongoose can't detect
    // in-place mutations on them, only whole-object reassignment, so force
    // change detection or these edits silently never reach the DB.
    order.markModified('pricing');
    order.markModified('serviceLines');
  }

  /**
   * What the customer still owes right now. One expression covers every case
   * settlement has to handle: a deferred order that has paid nothing, a legacy
   * on_delivery order, and a fully-paid order left short by a quality-hold
   * surcharge approved after collection. Replacing the old paymentTiming-keyed
   * gates with this is what let all four legacy-shim branches go away.
   */
  private outstandingCentavos(order: OnlineOrderDocument): number {
    const due = order.pricing.customerTotalCentavos ?? 0;
    const collected = order.paymentSummary?.amountCollectedCentavos ?? 0;
    return Math.max(0, due - collected);
  }

  /**
   * Records the Pay Now / Pay Later choice the customer makes once the weigh-in
   * has produced a real total. Checked against the snapshot taken at booking,
   * never the live branch, so a provider switching the setting off cannot make
   * a courier retract an option the customer was shown when they booked.
   */
  private resolvePickupPaymentTiming(
    order: OnlineOrderDocument,
    input: PaymentCollectionFields,
  ): PaymentTiming {
    const requested = input.paymentTiming ?? PaymentTiming.ON_PICKUP;
    if (requested !== PaymentTiming.AT_FINAL_HANDOVER) return requested;

    if (!order.provider.allowsPayAtHandover) {
      throw new BadRequestException(
        'This provider does not offer pay-at-handover',
      );
    }
    // Deferring and collecting are exclusive; a client sending both has a bug,
    // and silently honouring one of them would lose money either way.
    if (input.paymentMethod != null || input.tenderedCentavos != null) {
      throw new BadRequestException(
        'Payment details cannot be supplied when deferring to final handover',
      );
    }
    return requested;
  }

  /**
   * Debits whatever part of the platform fee has not been debited yet, and
   * records how much that now is. Normally the whole fee, once, at pickup — the
   * provider fronts it whether or not the customer paid (§18). The only time it
   * runs again is when an approved quality-hold surcharge raised the fee after
   * pickup, and then only as the surcharge is actually collected, so a provider
   * is never debited for an add-on the customer went on to refuse.
   */
  /**
   * Apply any platform-fee incentive this provider is entitled to.
   *
   * At acceptance, because that is the moment the provider commits to the
   * order — and because the customer must never see it. A fee waiver is
   * between Lalaba and the provider; it changes what the platform collects,
   * not what the customer pays.
   *
   * Best-effort by design. If this throws, the provider has already accepted a
   * real order and reversing that over a promotions lookup would be worse than
   * missing a discount — the same trade the customer promo path makes at
   * checkout, and logged as loudly.
   */
  private async applyPlatformFeePromo(
    order: OnlineOrderDocument,
    actor: User,
    session: ClientSession,
  ): Promise<void> {
    if (order.pricing.platformFeePromoId) return; // already granted
    try {
      const promo = await this.promotionsService.findPlatformFeePromoFor(
        this.roleIdOf(actor),
        order.provider.branchId,
      );
      if (!promo) return;

      const discount = waivablePlatformFeeCentavos(order.pricing);
      const reserved = await this.promotionsService.reserveForBranch({
        promoId: String(promo._id),
        branchId: order.provider.branchId,
        orderId: String(order._id),
        actorUid: actor._id,
        actorName:
          `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() ||
          actor._id,
        discountCentavos: discount,
      });
      if (!reserved) return; // someone took the last slot

      order.pricing.platformFeePromoId = String(promo._id);
      order.pricing.platformFeePromoCode = promo.code;
      order.pricing.platformFeeDiscountCentavos = discount;
      order.markModified('pricing');
      await order.save({ session });
    } catch (err) {
      this.logger.error(
        `Order ${String(order._id)} accepted, but the platform-fee promotion could not be applied: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
    }
  }

  private async consumeOutstandingFee(
    order: OnlineOrderDocument,
    session: ClientSession,
  ): Promise<void> {
    // NET of any promotional waiver, not the gross fee. A waiver is not wallet
    // money: staging it as a ₱20 debit and a ₱20 credit would put two entries
    // in the provider's ledger for an event where nothing moved. They simply
    // owe less.
    //
    // The `owed < consumed` branch below then handles a waiver granted after
    // part of the fee was already taken — it credits the difference back
    // through the same primitive an over-charge already uses, so that case
    // needed no new code.
    const owed = chargeablePlatformFeeCentavos(order.pricing);
    // Plain read, no inference. An earlier version guessed the baseline from
    // `paymentSummary.collectedAt`, which silently broke the ordinary pickup:
    // collection runs first in the same transaction and stamps collectedAt, so
    // the fee then looked already-consumed and was never debited. Orders that
    // predate this field are backfilled by scripts/migrations instead.
    const consumed = order.pricing.platformFeeConsumedCentavos ?? 0;
    if (owed === consumed) return;

    // A courier correcting a pickup weight downward (recordPickupWeight's
    // self-loop, see order-status.enum.ts) can lower `owed` below what was
    // already debited on the first pass — credit the branch the difference
    // rather than leaving them permanently over-charged for a mistyped
    // weight. Reuses the same wallet primitive the abandonment path uses to
    // return a fee the platform never should have kept.
    if (owed < consumed) {
      await this.walletsService.reverseFee(
        order.provider.branchId,
        consumed - owed,
        String(order._id),
        session,
      );
      order.pricing.platformFeeConsumedCentavos = owed;
      order.markModified('pricing');
      await order.save({ session });
      return;
    }

    await this.walletsService.consumeFee(
      order.provider.branchId,
      owed - consumed,
      String(order._id),
      session,
    );
    order.pricing.platformFeeConsumedCentavos = owed;
    order.markModified('pricing');
    await order.save({ session });
  }

  private async recordCollectionTransaction(
    order: OnlineOrderDocument,
    actor: User,
    input: PaymentCollectionFields,
    session: ClientSession,
    opts: { amountCentavos: number; status: OnlineTransactionStatus },
  ): Promise<void> {
    if (!input.paymentMethod) {
      throw new BadRequestException(
        'paymentMethod is required to collect payment',
      );
    }
    if (
      input.paymentMethod === PaymentMethod.EWALLET_OUTSIDE_APP &&
      !input.referenceId
    ) {
      throw new BadRequestException(
        'referenceId is required when paying via e-wallet',
      );
    }
    // Cash tender/change (GAP-H-017) — optional until DECISION_REQUIRED-004
    // settles the full tender model. Change is always computed server-side.
    // Due is what is OUTSTANDING, not the order total: collecting a ₱200
    // surcharge on a ₱650 order that was already paid must ask for ₱200.
    const amountDue = opts.amountCentavos;
    let tenderedCentavos: number | undefined;
    let changeCentavos: number | undefined;
    if (input.tenderedCentavos != null) {
      if (input.paymentMethod !== PaymentMethod.CASH) {
        throw new BadRequestException(
          'tenderedCentavos only applies to cash payments',
        );
      }
      if (input.tenderedCentavos < amountDue) {
        throw new BadRequestException(
          'Tendered cash is less than the amount due',
        );
      }
      tenderedCentavos = input.tenderedCentavos;
      changeCentavos = input.tenderedCentavos - amountDue;
    }
    // Merge, don't replace. collectedAt has to keep meaning FIRST settled —
    // several predicates read `collectedAt == null` as "never settled", and a
    // surcharge top-up must not make the original collection look days late.
    const prior = order.paymentSummary ?? {};
    const now = new Date();
    order.paymentSummary = {
      ...prior,
      method: input.paymentMethod,
      referenceId: input.referenceId ?? prior.referenceId,
      amountCollectedCentavos:
        (prior.amountCollectedCentavos ?? 0) + opts.amountCentavos,
      collectedByUid: actor._id,
      collectedAt: prior.collectedAt ?? now,
      lastCollectedAt: now,
      tenderedCentavos,
      changeCentavos,
    };
    await order.save({ session });
    await this.transactionModel.create(
      [
        {
          orderId: String(order._id),
          paymentMethod: input.paymentMethod,
          referenceId: input.referenceId ?? undefined,
          amountCentavos: opts.amountCentavos,
          tenderedCentavos,
          changeCentavos,
          status: opts.status,
          collectedByUid: actor._id,
          collectedByRole: this.roleIdOf(actor),
        },
      ],
      { session },
    );
  }

  private async saveAndTransition(
    order: OnlineOrderDocument,
    to: OrderStatus,
    actor: User,
    note?: string,
  ): Promise<OnlineOrder> {
    // pickupAssignment/returnAssignment are Object-typed (Mixed) — Mongoose
    // can't detect in-place property mutations on them, only whole-object
    // reassignment. Every caller here sets a timestamp field on one of these
    // (enRouteAt/arrivedAt/etc.), so mark both dirty defensively; a no-op
    // markModified on an already-clean or untouched path is harmless.
    order.markModified('pickupAssignment');
    order.markModified('returnAssignment');
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        await this.applyTransition(
          order,
          to,
          actor._id,
          this.roleIdOf(actor),
          session,
          note,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  // -------------------------------------------------------------------------
  // Failed pickup — same-day retry, then reschedule or cancel (§13)
  // -------------------------------------------------------------------------

  async recordFailedPickupAttempt(
    orderId: string,
    courier: User,
    input: RecordAttemptInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'pickup', courier._id);
    order.pickupAttempts.push({
      attemptNumber: order.pickupAttempts.length + 1,
      actorUid: courier._id,
      timestamp: new Date(),
      gpsLat: input.gpsLat,
      gpsLng: input.gpsLng,
      photoUrls: input.photoUrls,
      responsibility: input.responsibility,
      reason: input.reason,
    });
    return this.saveAndTransition(
      order,
      OrderStatus.PICKUP_ATTEMPT_FAILED,
      courier,
      input.reason,
    );
  }

  async retryPickupSameDay(orderId: string, actor: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    return this.saveAndTransition(order, OrderStatus.PICKUP_ASSIGNED, actor);
  }

  async escalateToReschedule(
    orderId: string,
    actor: User,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    return this.saveAndTransition(
      order,
      OrderStatus.AWAITING_PICKUP_RESCHEDULE,
      actor,
    );
  }

  async reschedulePickup(orderId: string, actor: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.customer.uid !== actor._id)
      throw new ForbiddenException('Not your order');
    order.pickupAssignment = null;
    return this.saveAndTransition(order, OrderStatus.PICKUP_ASSIGNED, actor);
  }

  async cancelAfterFailedPickup(
    orderId: string,
    actor: User,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.customer.uid !== actor._id)
      throw new ForbiddenException('Not your order');
    // No refund — nothing was ever collected (§13).
    return this.saveAndTransition(
      order,
      OrderStatus.CANCELLED,
      actor,
      'No refund — nothing collected',
    );
  }

  // -------------------------------------------------------------------------
  // Drop-off receipt (customer_dropoff path)
  // -------------------------------------------------------------------------

  async receiveAtCounter(
    orderId: string,
    actor: User,
    input: RecordCollectionInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    this.finalizePricing(
      order,
      input.actualWeightKg,
      input.actualPieceCount,
      input.lineActuals,
    );
    this.applyHandoverProof(order, 'pickup', input.proofObjectKeys, actor._id);
    // Same rule as the courier path: collect now unless the customer defers to
    // final handover, which only an opted-in provider may offer.
    order.paymentTiming = this.resolvePickupPaymentTiming(order, input);
    const collectNow = order.paymentTiming === PaymentTiming.ON_PICKUP;

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        if (collectNow) {
          await this.recordCollectionTransaction(order, actor, input, session, {
            amountCentavos: this.outstandingCentavos(order),
            status: OnlineTransactionStatus.COMPLETED,
          });
        }
        await this.consumeOutstandingFee(order, session);
        await this.applyTransition(
          order,
          OrderStatus.RECEIVED_BY_PROVIDER,
          actor._id,
          this.roleIdOf(actor),
          session,
        );
        await this.applyTransition(
          order,
          OrderStatus.LAUNDRY_IN_PROGRESS,
          actor._id,
          this.roleIdOf(actor),
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  // -------------------------------------------------------------------------
  // Processing & quality holds (§12)
  // -------------------------------------------------------------------------

  async markLaundryReady(orderId: string, actor: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    const next =
      order.fulfillment.returnMode ===
      FulfillmentReturnMode.CUSTOMER_SELF_PICKUP
        ? OrderStatus.AWAITING_CUSTOMER_PICKUP
        : OrderStatus.AWAITING_RETURN_ASSIGNMENT;
    return this.saveAndTransition(order, OrderStatus.LAUNDRY_READY, actor).then(
      (o) => this.saveAndTransition(o as OnlineOrderDocument, next, actor),
    );
  }

  async raiseQualityHold(
    orderId: string,
    actor: User,
    input: RaiseQualityHoldInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);

    // An out-of-range index would sail through here and only surface later,
    // when respondToQualityHold looks up order.serviceLines[index] and finds
    // nothing — silently dropping an approved surcharge.
    if (input.serviceLineIndex >= order.serviceLines.length) {
      throw new BadRequestException('That service is not on this order');
    }

    // One hold at a time. This used to overwrite `activeQualityHold` outright,
    // so a double-submit — or a provider raising a second issue before the
    // customer answered the first — silently destroyed the pending hold, threw
    // away its history, and pushed an order the customer had ALREADY resolved
    // back into a blocked state. Seen in the wild: an order went
    // laundry_in_progress → hold → approved → hold again, with the second raise
    // erasing the approval.
    if (order.activeQualityHold && !order.activeQualityHold.resolvedAt) {
      throw new BadRequestException(
        'This order already has a quality hold waiting to be resolved',
      );
    }

    order.activeQualityHold = {
      serviceLineIndex: input.serviceLineIndex,
      category: input.category,
      reason: input.reason,
      photoUrls: input.photoUrls,
      blocksOrder: input.blocksOrder,
      additionalChargeCentavos: input.additionalChargeCentavos,
      customerResponse: QualityHoldResponse.PENDING,
      raisedAt: new Date(),
      respondTimeoutAt: input.blocksOrder
        ? new Date(Date.now() + 24 * 3600 * 1000) // 24h response window before safest-default auto-resolve
        : undefined,
    };

    if (!input.blocksOrder) {
      // Documentary only — provider resolves it unilaterally right here,
      // order keeps processing without ever pausing (§12).
      order.activeQualityHold.resolvedAt = new Date();
      return this.saveOrderOnly(order);
    }

    return this.saveAndTransition(
      order,
      OrderStatus.LAUNDRY_QUALITY_HOLD,
      actor,
      input.reason,
    );
  }

  async respondToQualityHold(
    orderId: string,
    customer: User,
    input: RespondToQualityHoldInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.customer.uid !== customer._id)
      throw new ForbiddenException('Not your order');
    if (!order.activeQualityHold) {
      throw new BadRequestException('No active quality hold on this order');
    }
    // Idempotency vs the timeout worker (GAP-H-014): a hold resolves exactly
    // once — whoever comes second (late customer tap or a racing sweep) is
    // told clearly instead of double-applying charges/transitions.
    if (order.activeQualityHold.resolvedAt != null) {
      throw new BadRequestException(
        'This quality hold has already been resolved',
      );
    }
    if (
      order.activeQualityHold.respondTimeoutAt != null &&
      Date.now() > order.activeQualityHold.respondTimeoutAt.getTime()
    ) {
      throw new BadRequestException(
        'The response window for this quality hold has expired — the order proceeds without the extra treatment',
      );
    }

    order.activeQualityHold.customerResponse = input.approve
      ? QualityHoldResponse.APPROVED
      : QualityHoldResponse.DECLINED;
    order.activeQualityHold.resolvedAt = new Date();

    if (input.approve && order.activeQualityHold.additionalChargeCentavos) {
      const line = order.serviceLines[order.activeQualityHold.serviceLineIndex];
      if (line) {
        // Integer centavos — the field is Int on both the schema and the input
        // DTO now (SEC-007), but round defensively for orders written by an
        // older build when it was a Float.
        const surchargeCentavos = Math.round(
          order.activeQualityHold.additionalChargeCentavos,
        );
        // SEC-007 — platform-fee avoidance. The surcharge used to be added to
        // customerTotalCentavos while platformFeeCentavos was left at the
        // value computed in finalizePricing, so every peso a provider moved
        // out of the base service price and into an "approved quality-hold
        // surcharge" escaped the platform fee entirely. The fee is now
        // recomputed over the surcharge with the SAME rate snapshotted at
        // booking (platformFeePercent), exactly as the base service is
        // charged, and the surcharge is folded into the actual service total
        // so the two stay reconcilable.
        const surchargeFeeCentavos = calculatePlatformFee(
          surchargeCentavos,
          order.pricing.platformFeePercent ?? 0,
        );
        line.actualLineTotalCentavos =
          (line.actualLineTotalCentavos ?? 0) + surchargeCentavos;
        order.pricing.actualServiceTotalCentavos =
          (order.pricing.actualServiceTotalCentavos ?? 0) + surchargeCentavos;
        order.pricing.platformFeeCentavos =
          (order.pricing.platformFeeCentavos ?? 0) + surchargeFeeCentavos;
        // Recorded separately as well as folded into the total above. The
        // total is what the provider owes; this is the part of it that came
        // from a penalty rather than from the fee rule, and only the latter
        // can ever be waived by a promotion. Cumulative — an order can be held
        // more than once.
        order.pricing.platformFeeSurchargeCentavos =
          (order.pricing.platformFeeSurchargeCentavos ?? 0) +
          surchargeFeeCentavos;
        order.pricing.customerTotalCentavos =
          (order.pricing.customerTotalCentavos ?? 0) +
          surchargeCentavos +
          surchargeFeeCentavos;
      }
    }
    // Object-typed (Mixed) sub-docs — force change detection or the in-place
    // edits above (resolvedAt, surcharge) silently never reach the DB.
    order.markModified('activeQualityHold');
    order.markModified('serviceLines');
    order.markModified('pricing');
    // Approve or decline, the order always proceeds — never a cancellation
    // branch from a hold response (§12).
    return this.saveAndTransition(
      order,
      OrderStatus.LAUNDRY_IN_PROGRESS,
      customer,
    );
  }

  /** Scheduled-job entry point (see QualityHoldSchedulerService) for holds
   * that time out unanswered — resolves to the safest/cheapest default (skip
   * the extra treatment) automatically. Idempotent: a hold that was already
   * resolved (by the customer, or by a racing sweep on another instance) or
   * that hasn't actually expired yet is left untouched, no error. */
  async autoResolveExpiredQualityHold(orderId: string): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    const hold = order.activeQualityHold;
    if (
      !hold ||
      order.status !== OrderStatus.LAUNDRY_QUALITY_HOLD ||
      hold.resolvedAt != null ||
      hold.respondTimeoutAt == null ||
      Date.now() < hold.respondTimeoutAt.getTime()
    ) {
      return order; // nothing to resolve — idempotent no-op
    }
    hold.customerResponse = QualityHoldResponse.DECLINED;
    hold.resolvedAt = new Date();
    order.markModified('activeQualityHold'); // Mixed sub-doc — force change detection
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        await this.applyTransition(
          order,
          OrderStatus.LAUNDRY_IN_PROGRESS,
          'system',
          'system',
          session,
          'Auto-resolved: response window expired, proceeding without extra charge',
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  private async saveOrderOnly(
    order: OnlineOrderDocument,
  ): Promise<OnlineOrder> {
    return order.save();
  }

  // -------------------------------------------------------------------------
  // Return-mode exception (§11, rare)
  // -------------------------------------------------------------------------

  async chooseReturnOption(
    orderId: string,
    customer: User,
    returnMode: FulfillmentReturnMode,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.customer.uid !== customer._id)
      throw new ForbiddenException('Not your order');
    order.fulfillment.returnMode = returnMode;
    const next =
      returnMode === FulfillmentReturnMode.CUSTOMER_SELF_PICKUP
        ? OrderStatus.AWAITING_CUSTOMER_PICKUP
        : OrderStatus.AWAITING_RETURN_ASSIGNMENT;
    return this.saveAndTransition(order, next, customer);
  }

  // -------------------------------------------------------------------------
  // Return delivery
  // -------------------------------------------------------------------------

  async assignReturnStaff(
    orderId: string,
    actor: User,
    staffUid: string,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    await this.assertAssignableCourier(order, staffUid, actor);
    order.returnAssignment = {
      assignedStaffUid: staffUid,
      assignedAt: new Date(),
    };
    return this.saveAndTransition(order, OrderStatus.RETURN_ASSIGNED, actor);
  }

  async startReturnRoute(orderId: string, courier: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'return', courier._id);
    order.returnAssignment!.enRouteAt = new Date();
    return this.saveAndTransition(order, OrderStatus.RETURN_EN_ROUTE, courier);
  }

  async arriveAtReturn(orderId: string, courier: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'return', courier._id);
    order.returnAssignment!.arrivedAt = new Date();
    return this.saveAndTransition(order, OrderStatus.RETURN_ARRIVED, courier);
  }

  /**
   * `input` carries the collection details for whatever is still owed — the
   * whole amount on an order that deferred at pickup, or just a quality-hold
   * surcharge approved after it was paid. An already-settled order passes none.
   *
   * Money before custody is enforced by transaction atomicity, the same way the
   * pickup path enforces it: a rejected collection throws inside
   * `withTransaction`, so DELIVERED_TO_CUSTOMER and COMPLETED never land and
   * the courier still has the laundry. When the customer simply cannot pay, the
   * courier records a failed attempt instead and the goods go back to the shop.
   */
  async recordDelivery(
    orderId: string,
    courier: User,
    input?: RecordCollectionInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'return', courier._id);

    const outstanding = this.outstandingCentavos(order);
    if (outstanding > 0 && !input?.paymentMethod) {
      throw new BadRequestException(
        'Payment must be collected before handover — provide paymentMethod',
      );
    }

    // Only after the guard, so a rejected handover doesn't hand the caller back
    // a document that looks delivered.
    order.returnAssignment!.completedAt = new Date();
    order.markModified('returnAssignment'); // Object-typed sub-doc — force change detection
    this.applyHandoverProof(
      order,
      'return',
      input?.proofObjectKeys,
      courier._id,
    );
    order.completedAt = new Date();

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        if (outstanding > 0) {
          await this.recordCollectionTransaction(
            order,
            courier,
            input ?? {},
            session,
            {
              amountCentavos: outstanding,
              // A deferred order settling for the first time is a plain
              // collection; topping up an order that already paid is the
              // add-on the transaction log was designed for.
              status:
                order.paymentSummary?.collectedAt == null
                  ? OnlineTransactionStatus.COMPLETED
                  : OnlineTransactionStatus.ADD_ON,
            },
          );
          // Any fee on a surcharge that was approved after pickup is debited
          // now, as the surcharge is actually collected.
          await this.consumeOutstandingFee(order, session);
        }
        await this.applyTransition(
          order,
          OrderStatus.DELIVERED_TO_CUSTOMER,
          courier._id,
          this.roleIdOf(courier),
          session,
        );
        // Auto-completes — no customer confirmation tap (§12).
        await this.applyTransition(
          order,
          OrderStatus.COMPLETED,
          courier._id,
          this.roleIdOf(courier),
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  async recordFailedDeliveryAttempt(
    orderId: string,
    courier: User,
    input: RecordAttemptInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    this.assertAssignedCourier(order, 'return', courier._id);
    order.deliveryAttempts.push({
      attemptNumber: order.deliveryAttempts.length + 1,
      actorUid: courier._id,
      timestamp: new Date(),
      gpsLat: input.gpsLat,
      gpsLng: input.gpsLng,
      photoUrls: input.photoUrls,
      responsibility: input.responsibility,
      reason: input.reason,
    });
    return this.saveAndTransition(
      order,
      OrderStatus.DELIVERY_ATTEMPTED,
      courier,
      input.reason,
    );
  }

  async confirmReturnedToProvider(
    orderId: string,
    actor: User,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);
    return this.saveAndTransition(
      order,
      OrderStatus.RETURNED_TO_PROVIDER,
      actor,
    ).then((o) =>
      this.saveAndTransition(
        o as OnlineOrderDocument,
        OrderStatus.AWAITING_REDELIVERY_SELECTION,
        actor,
      ),
    );
  }

  /** Unlimited attempts, any available courier — no cap (§13). */
  async scheduleRedelivery(orderId: string, actor: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.customer.uid !== actor._id) {
      await this.assertBranchOwnership(order.provider.branchId, actor);
    }
    order.returnAssignment = null;
    return this.saveAndTransition(
      order,
      OrderStatus.REDELIVERY_SCHEDULED,
      actor,
    ).then((o) =>
      this.saveAndTransition(
        o as OnlineOrderDocument,
        OrderStatus.RETURN_ASSIGNED,
        actor,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Self-pickup
  // -------------------------------------------------------------------------

  /** `input` settles whatever is still owed when the customer collects at the
   * counter — mirrors the courier's recordDelivery, including the rule that the
   * laundry does not change hands until the balance is zero. Self-pickup has no
   * failed-attempt path: a customer who never returns is caught by the
   * abandonment window instead, which makes that window a real product
   * parameter here rather than a backstop. */
  async verifySelfPickup(
    orderId: string,
    actor: User,
    input?: RecordCollectionInput,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    await this.assertBranchOwnership(order.provider.branchId, actor);

    const outstanding = this.outstandingCentavos(order);
    if (outstanding > 0 && !input?.paymentMethod) {
      throw new BadRequestException(
        'Payment must be collected before handover — provide paymentMethod',
      );
    }

    this.applyHandoverProof(order, 'return', input?.proofObjectKeys, actor._id);
    order.completedAt = new Date();
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await order.save({ session });
        if (outstanding > 0) {
          await this.recordCollectionTransaction(
            order,
            actor,
            input ?? {},
            session,
            {
              amountCentavos: outstanding,
              status:
                order.paymentSummary?.collectedAt == null
                  ? OnlineTransactionStatus.COMPLETED
                  : OnlineTransactionStatus.ADD_ON,
            },
          );
          await this.consumeOutstandingFee(order, session);
        }
        await this.applyTransition(
          order,
          OrderStatus.CUSTOMER_PICKUP_VERIFIED,
          actor._id,
          this.roleIdOf(actor),
          session,
        );
        await this.applyTransition(
          order,
          OrderStatus.COMPLETED,
          actor._id,
          this.roleIdOf(actor),
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  // -------------------------------------------------------------------------
  // Handover proof
  // -------------------------------------------------------------------------

  /**
   * Stores one proof frame for a leg and returns its storage key.
   *
   * Private storage, not the public branding bucket uploadMedia uses: these
   * photos show a customer's doorway and their belongings, so they get the same
   * treatment as KYC evidence — no anonymous read, short-lived signed URLs only.
   *
   * Upload happens BEFORE the collection mutation rather than inside it: the
   * collection runs in a Mongo transaction, and pushing megabytes to object
   * storage inside a transaction would hold it open for the length of a mobile
   * upload. The caller passes the returned keys to recordPickup/recordDelivery.
   */
  async uploadHandoverProof(
    orderId: string,
    leg: 'pickup' | 'return',
    base64: string,
    mimeType: string,
    actor: User,
  ): Promise<string> {
    const order = await this.findOrderOrThrow(orderId);
    // Same authority that may record the handover may photograph it.
    if (leg === 'pickup' && order.pickupAssignment?.assignedStaffUid) {
      this.assertAssignedCourier(order, 'pickup', actor._id);
    } else if (leg === 'return' && order.returnAssignment?.assignedStaffUid) {
      this.assertAssignedCourier(order, 'return', actor._id);
    } else {
      // Counter paths have no courier leg — the shop itself hands over.
      await this.assertBranchOwnership(order.provider.branchId, actor);
    }

    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
      throw new BadRequestException('Proof must be a JPEG, PNG or WebP image');
    }
    const data = base64.includes(',') ? base64.split(',')[1] : base64;
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new BadRequestException('No image was provided.');
    }
    const buffer = Buffer.from(data, 'base64');
    const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
    // No `private-evidence/` prefix here — uploadPrivate adds it. Passing it
    // produced keys like `private-evidence/private-evidence/handover/...`.
    const key = `handover/${orderId}/${leg}-${Date.now()}.${ext}`;
    return this.storageProvider.uploadPrivate(buffer, key, mimeType);
  }

  /**
   * Short-lived signed URLs for a leg's proof frames.
   *
   * Visible to the customer on the order, the provider that handled it, and the
   * courier who captured them — nobody else, because the frames show a private
   * address. Returns [] rather than throwing for everyone else, so a list query
   * that happens to include the field does not fail wholesale.
   */
  async handoverProofUrls(
    order: OnlineOrder,
    leg: 'pickup' | 'return',
    viewer: User,
  ): Promise<string[]> {
    const viewerUid = viewer._id;
    const proof = leg === 'pickup' ? order.pickupProof : order.returnProof;
    if (!proof?.objectKeys?.length) return [];

    const isCustomer = order.customer.uid === viewerUid;
    const isCourier =
      order.pickupAssignment?.assignedStaffUid === viewerUid ||
      order.returnAssignment?.assignedStaffUid === viewerUid;
    let isProvider = false;
    try {
      await this.assertBranchOwnership(order.provider.branchId, viewer);
      isProvider = true;
    } catch {
      isProvider = false;
    }
    if (!isCustomer && !isCourier && !isProvider) return [];

    return Promise.all(
      proof.objectKeys.map((k) =>
        this.storageProvider.getSignedReadUrl(
          k,
          DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
        ),
      ),
    );
  }

  /** Stamps captured proof onto the order's leg. Called inside the collection. */
  private applyHandoverProof(
    order: OnlineOrderDocument,
    leg: 'pickup' | 'return',
    objectKeys: string[] | undefined,
    actorUid: string,
  ): void {
    if (!objectKeys?.length) return;
    const proof = {
      objectKeys,
      capturedAt: new Date(),
      capturedByUid: actorUid,
    };
    if (leg === 'pickup') order.pickupProof = proof;
    else order.returnProof = proof;
    order.markModified(leg === 'pickup' ? 'pickupProof' : 'returnProof');
  }

  // -------------------------------------------------------------------------
  // Abandonment (deferred settlement that never settled)
  // -------------------------------------------------------------------------

  /**
   * Support's view of the money that hasn't come in: every order still owing
   * something, plus every order already given up on. Platform-wide and
   * deliberately unscoped by branch — it exists so somebody can chase the
   * balances nobody else is looking at.
   *
   * Newest first, like every other list in the product. Sorting by how close
   * each one is to being written off would read better for triage, but the
   * abandonment deadline is cleared once an order is abandoned, and putting
   * those nulls last needs an aggregation this doesn't otherwise require.
   */
  /**
   * Platform-wide order search for admin/support.
   *
   * Until this existed the only way in was `onlineOrder(id)` — an exact Mongo
   * ObjectId. There is no short human-readable order number anywhere in the
   * product, so a support agent taking a call had literally no way to find the
   * order being complained about unless the customer could read out a 24-char
   * hex string.
   *
   * Deliberately unscoped by branch, and admin/support only.
   */
  async adminSearchOrders(filter: AdminOrderFilterInput = {}): Promise<{
    data: OnlineOrder[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const conditions: QueryFilter<OnlineOrderDocument>[] = [];

    if (filter.statuses?.length) {
      conditions.push({ status: { $in: filter.statuses } });
    }
    if (filter.providerType) {
      conditions.push({ 'provider.providerType': filter.providerType });
    }
    if (filter.branchId) {
      conditions.push({ 'provider.branchId': filter.branchId });
    }
    if (filter.customerUid) {
      conditions.push({ 'customer.uid': filter.customerUid });
    }
    if (filter.outstandingBalanceOnly) {
      // Same comparison unsettledOrders makes: the two amounts live in
      // different sub-documents, so it has to be an $expr rather than a plain
      // field query.
      conditions.push({
        $expr: {
          $gt: [
            { $ifNull: ['$pricing.customerTotalCentavos', 0] },
            { $ifNull: ['$paymentSummary.amountCollectedCentavos', 0] },
          ],
        },
      });
    }

    if (filter.dateFrom || filter.dateTo) {
      // Both bounds are widened to whole PHILIPPINE days, not whole
      // server-local days. An admin picking "the 14th" means the 14th as it
      // was lived in Manila; on a UTC-hosted server, treating the bound
      // literally would cut the day at 8 AM local and quietly drop the
      // evening's orders — the busiest part of a laundry day.
      const range: Record<string, Date> = {};
      if (filter.dateFrom) range.$gte = manilaDayStart(filter.dateFrom);
      if (filter.dateTo) range.$lte = manilaDayEnd(filter.dateTo);
      conditions.push({ createdAt: range });
    }

    const search = filter.search?.trim();
    if (search) {
      const searchClause = await this.buildOrderSearchClause(search);
      // A search that resolves to nothing must return nothing — without this
      // the clause would be dropped and the caller would get every order on
      // the platform, which reads as "found everything" rather than "found
      // nothing".
      if (!searchClause) {
        return { data: [], total: 0, limit, offset };
      }
      conditions.push(searchClause);
    }

    const query: QueryFilter<OnlineOrderDocument> =
      conditions.length > 0 ? { $and: conditions } : {};

    const [data, total] = await Promise.all([
      this.orderModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.orderModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit, offset };
  }

  /**
   * Turns one search box into the right query, by working out what kind of
   * identifier the agent actually pasted.
   *
   * Returns null when the term is recognisably an identifier that matches
   * nothing — a phone number belonging to no user — so the caller can return
   * an empty page rather than silently widening the search.
   */
  private async buildOrderSearchClause(
    term: string,
  ): Promise<QueryFilter<OnlineOrderDocument> | null> {
    // "LB-000123" (or "LB000123", or just the digits with the prefix typed
    // loosely) — the human-readable number, checked before the id/phone/name
    // branches below since it has its own unambiguous shape. Orders placed
    // before orderNumber existed have none and simply never match here.
    const orderNumberMatch = /^lb-?(\d{1,6})$/i.exec(term.trim());
    if (orderNumberMatch) {
      const padded = orderNumberMatch[1].padStart(6, '0');
      return { orderNumber: `LB-${padded}` };
    }

    // An ObjectId-shaped term is an id, not a name. Matched against the order
    // id and both party uids, since all three are ObjectId strings and an
    // agent copying one out of another screen rarely knows which they took.
    if (isValidObjectId(term) && /^[a-f\d]{24}$/i.test(term)) {
      return {
        $or: [
          // Cast: the schema declares `_id: string` but the hydrated document
          // type is `string & ObjectId`, so a plain string fails the strict
          // condition type even though Mongoose casts it at query time —
          // exactly what `findById(orderId)` relies on elsewhere in this file.
          { _id: term as unknown as OnlineOrderDocument['_id'] },
          { 'customer.uid': term },
          { 'provider.providerUid': term },
          { 'provider.branchId': term },
        ],
      };
    }

    // Phone numbers are resolved through the USER record on purpose: the order
    // snapshot stores `maskedPhone` (0917•••4567), so the digits a customer
    // reads out over the phone can never match what is stored on the order.
    const digits = term.replace(/[^\d]/g, '');
    if (digits.length >= 7 && /^[\d\s()+-]+$/.test(term)) {
      // Match the tail, so 09171234567, +639171234567 and 9171234567 all find
      // the same person.
      const tail = digits.slice(-10);
      const users = await this.userModel
        .find({ phoneNumber: { $regex: `${escapeRegex(tail)}$` } })
        .select('_id')
        .limit(50)
        .exec();
      if (users.length === 0) return null;
      const uids = users.map((u) => String(u._id));
      return {
        $or: [
          { 'customer.uid': { $in: uids } },
          { 'provider.providerUid': { $in: uids } },
        ],
      };
    }

    // Otherwise a name — matched against both parties, because "find Maria's
    // order" is as likely to mean the washer as the customer.
    //
    // Exact uid matches ride along here rather than in the ObjectId branch
    // above: `customer.uid` is a FIREBASE uid (a ~28-character alphanumeric
    // string), not an ObjectId, so a uid copied from another admin screen
    // never reaches that branch. Without these two clauses it would be
    // treated as a name and match nothing.
    const pattern = new RegExp(escapeRegex(term), 'i');
    return {
      $or: [
        { 'customer.displayName': pattern },
        { 'provider.providerName': pattern },
        { 'customer.uid': term },
        { 'provider.providerUid': term },
      ],
    };
  }

  async unsettledOrders(
    limit = 50,
    offset = 0,
  ): Promise<{
    data: OnlineOrder[];
    total: number;
    limit: number;
    offset: number;
  }> {
    // "Owes money" cannot be a plain query — customerTotalCentavos and
    // amountCollectedCentavos live in different sub-documents, so the
    // comparison is an $expr over both.
    const filter = {
      $or: [
        { status: OrderStatus.ABANDONED_UNSETTLED },
        {
          status: { $in: ABANDONMENT_WAITING_STATES },
          $expr: {
            $gt: [
              { $ifNull: ['$pricing.customerTotalCentavos', 0] },
              { $ifNull: ['$paymentSummary.amountCollectedCentavos', 0] },
            ],
          },
        },
      ],
    };

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);
    return { data, total, limit, offset };
  }

  /**
   * The states an admin may move this order to right now.
   *
   * Read straight off the same transition table the state machine enforces, so
   * the picker can never offer something `applyTransition` would then reject.
   * A terminal state returns an empty list, which is the honest answer rather
   * than a disabled control with no explanation.
   */
  async allowedNextStatuses(orderId: string): Promise<OrderStatus[]> {
    const order = await this.findOrderOrThrow(orderId);
    return ORDER_STATUS_TRANSITIONS[order.status] ?? [];
  }

  /**
   * Manual status override for admin/support.
   *
   * Deliberately NOT a bypass of the state machine. It routes through
   * `applyTransition` like every other mutation, which means it is validated
   * against the transition table, it bumps the optimistic-concurrency version,
   * it writes the append-only order event, and — the part a bypass would
   * silently get wrong — it maintains the express SLA clock and the
   * abandonment deadline, both of which are stamped and cleared inside that
   * method.
   *
   * So this does not let support invent a state; it lets them advance one that
   * is already legal when the app that should have done it did not. The
   * screens that need to skip the rules outright (a refund, a reinstatement)
   * have their own purpose-built mutations, which is where that judgement
   * belongs.
   *
   * A note is required by the resolver: an override with no explanation is the
   * kind of thing that makes an order's history unreadable six months later.
   */
  async overrideStatus(
    orderId: string,
    to: OrderStatus,
    actor: User,
    note: string,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);

    if (order.status === to) {
      throw new BadRequestException('Order is already in that status');
    }

    const allowed = ORDER_STATUS_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(to)) {
      // assertValidTransition would reject this too, but its message is aimed
      // at a developer. An admin needs to know what they CAN do instead.
      throw new BadRequestException(
        allowed.length === 0
          ? `This order is in a terminal state (${order.status}) and cannot be moved.`
          : `Cannot move from ${order.status} to ${to}. Allowed: ${allowed.join(', ')}.`,
      );
    }

    return this.saveAndTransition(order, to, actor, note);
  }

  /**
   * Gives up on an order the customer never paid for and never collected.
   * Stops further redelivery by state machine alone — `scheduleRedelivery`
   * routes through `assertValidTransition`, and no edge leads out of
   * ABANDONED_UNSETTLED except the admin reinstatement below.
   *
   * Reverses the platform fee the provider fronted at pickup: they did the
   * work, were debited the platform's cut, and collected nothing, and the
   * platform earned nothing either. Reverses only what was actually consumed,
   * so a surcharge that was never debited can't be refunded into existence.
   *
   * Idempotent — a sweep racing another instance, or a second pass over the
   * same order, finds it already abandoned and returns it untouched.
   */
  async abandonUnsettledOrder(
    orderId: string,
    actor?: User,
    note?: string,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.status === OrderStatus.ABANDONED_UNSETTLED) return order;

    const actorUid = actor?._id ?? 'system';
    const actorRole = actor ? this.roleIdOf(actor) : 'system';
    const reversible = order.pricing.platformFeeConsumedCentavos ?? 0;

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (reversible > 0) {
          await this.walletsService.reverseFee(
            order.provider.branchId,
            reversible,
            String(order._id),
            session,
          );
          order.pricing.platformFeeConsumedCentavos = 0;
          order.markModified('pricing');
        }
        await order.save({ session });
        await this.applyTransition(
          order,
          OrderStatus.ABANDONED_UNSETTLED,
          actorUid,
          actorRole,
          session,
          note ?? 'Unsettled past the abandonment window',
        );
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  /**
   * Support escape hatch for the customer who turns up a week late with cash.
   * Puts the order back in the waiting state its return mode implies, which
   * re-arms the abandonment clock through applyTransition. The fee reversed on
   * abandonment is deliberately NOT re-consumed here — it is charged again when
   * the balance is finally collected, via consumeOutstandingFee.
   */
  async reinstateAbandonedOrder(
    orderId: string,
    actor: User,
    note?: string,
  ): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.status !== OrderStatus.ABANDONED_UNSETTLED) {
      throw new BadRequestException('Order is not abandoned');
    }
    const target =
      order.fulfillment.returnMode ===
      FulfillmentReturnMode.CUSTOMER_SELF_PICKUP
        ? OrderStatus.AWAITING_CUSTOMER_PICKUP
        : OrderStatus.AWAITING_REDELIVERY_SELECTION;

    return this.saveAndTransition(
      order,
      target,
      actor,
      note ?? 'Reinstated by support',
    );
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Whether the order's provider currently holds the Verified badge.
   *
   * Resolved live off the provider document rather than stored in the
   * ProviderSnapshot: a partner verified after the order was placed should
   * show as verified on it, and an order must never contradict the provider's
   * own profile page. Derived from `verifiedAt != null`, the same rule
   * discovery uses — never from verificationStatus.
   */
  async isProviderVerified(order: OnlineOrder): Promise<boolean> {
    const { providerType, branchId } = order.provider;
    if (providerType === ProviderType.WASHER) {
      const washer = await this.washerProfileModel
        .findOne({ branchId })
        .select('verifiedAt')
        .exec();
      return washer?.verifiedAt != null;
    }
    const branch = await this.branchModel
      .findById(branchId)
      .select('verifiedAt')
      .exec();
    return branch?.verifiedAt != null;
  }

  async myOrders(customerUid: string): Promise<OnlineOrder[]> {
    return this.orderModel
      .find({ 'customer.uid': customerUid })
      .sort({ createdAt: -1 })
      .exec();
  }

  async order(orderId: string, requester: User): Promise<OnlineOrder> {
    const order = await this.findOrderOrThrow(orderId);
    const isOwnerCustomer = order.customer.uid === requester._id;
    const isProvider = order.provider.providerUid === requester._id;
    const isAssignedCourier =
      order.pickupAssignment?.assignedStaffUid === requester._id ||
      order.returnAssignment?.assignedStaffUid === requester._id;
    if (!isOwnerCustomer && !isProvider && !isAssignedCourier) {
      const role = this.roleIdOf(requester);
      if (role !== 'admin' && role !== 'support') {
        throw new ForbiddenException('Not authorized to view this order');
      }
    }
    return order;
  }

  async incomingOrders(branchId: string, actor: User): Promise<OnlineOrder[]> {
    await this.assertBranchOwnership(branchId, actor);
    return this.orderModel
      .find({ 'provider.branchId': branchId })
      .sort({ createdAt: -1 })
      .exec();
  }

  /** The courier's work queue (New/Active) plus a bounded recent-history
   * window (Completed) — a courier app needs both, not just open work, so
   * COMPLETED orders aren't excluded outright, just capped to the last 7
   * days/100 orders to keep the query cheap. CANCELLED/REFUNDED stay excluded
   * — they're not meaningful "completed" history for a courier. */
  /**
   * The customer's real phone number, for the rider currently working a leg.
   *
   * The order snapshot stores only `maskedPhone` on purpose, so this reads the
   * live user record instead — and only inside `activeCourierLeg`'s window, so
   * the number is not readable before the rider sets off, after the leg is
   * handed over, or by anyone who merely has visibility of the order.
   */
  /**
   * Redacted view of the customer snapshot (RISK-P0-009), resolved per
   * request on the `customer` field. Full data (exact address, coords,
   * maskedPhone) is visible to: the customer, the provider owner, non-courier
   * staff of the provider's tenant, admin/support, and the courier the leg is
   * ASSIGNED to. Everyone else gets displayName + areaLabel only.
   */
  /**
   * The precise-location predicate for everything EXCEPT the customer
   * snapshot: the doorstep GPS recorded on a delivery/pickup attempt
   * (SEC-001) and the free-text access instructions that carry gate codes and
   * unit numbers (SEC-010). Both stay on the narrow live-leg window — a rider
   * needs a gate code when they arrive, not when the job lands on their board.
   *
   * The customer's own address/coords used to be gated here too and are not
   * anymore; see canSeeCustomerLocation() below for what changed and why.
   *
   * True for the customer themselves, the provider owner, non-courier staff of
   * the provider's tenant, and admin/support. A courier is true ONLY while
   * their own leg is live (activeCourierLeg) — never before setting off, never
   * after handover, and never on the other rider's leg.
   */
  private canSeePreciseLocation(order: OnlineOrder, requester: User): boolean {
    const roleId = this.roleIdOf(requester);
    const isOwnerCustomer = order.customer?.uid === requester._id;
    const isProviderOwner = order.provider.providerUid === requester._id;
    const isAdmin = roleId === 'admin' || roleId === 'support';
    const isNonCourierProviderStaff =
      roleId !== 'courier' &&
      (requester.merchantId === order.provider.providerUid ||
        (requester.branchIds ?? [])
          .map(String)
          .includes(String(order.provider.branchId)));
    const isCourierOnLiveLeg = activeCourierLeg(order, requester._id) !== null;

    return (
      isOwnerCustomer ||
      isProviderOwner ||
      isAdmin ||
      isNonCourierProviderStaff ||
      isCourierOnLiveLeg
    );
  }

  /**
   * Who may see the customer's exact address and drop pin (RISK-P0-009).
   *
   * Everyone canSeePreciseLocation() allows, PLUS the courier the leg is
   * assigned to — from the moment it lands on their board, not from the moment
   * they set off.
   *
   * The original live-leg window made a courier's own unstarted stops
   * unplottable: `mapLocation` came back undefined for every NEW leg, so the
   * map silently dropped those pins and a rider with ten jobs saw three. A
   * courier cannot plan, sequence, or judge a route they are not allowed to
   * see, and the feed only ever returns orders already assigned to them, so
   * the narrow window bought no real confidentiality — it withheld the address
   * of a job the rider was about to be sent to anyway, minutes later.
   *
   * What it still withholds is unchanged: a courier gets nothing on an order
   * that was never assigned to them, and nothing on the other rider's leg.
   */
  private canSeeCustomerLocation(order: OnlineOrder, requester: User): boolean {
    if (this.canSeePreciseLocation(order, requester)) return true;
    return (
      this.roleIdOf(requester) === 'courier' &&
      assignedCourierLeg(order, requester._id) !== null
    );
  }

  /**
   * SEC-001 — doorstep coordinates on attempt evidence.
   *
   * `pickupAttempts`/`deliveryAttempts` were plain GraphQL fields, so the
   * house-level gpsLat/gpsLng captured on every failed attempt were readable
   * by any courier who could see the order — after their leg closed, or on a
   * leg that was never theirs — completely bypassing the redaction applied to
   * `customer.mapLocation`. The coordinates are now stripped unless the viewer
   * passes the same active-leg test.
   */
  attemptsFor(
    attempts: AttemptEvidence[] | undefined,
    order: OnlineOrder,
    requester: User,
  ): AttemptEvidence[] {
    const list = attempts ?? [];
    if (this.canSeePreciseLocation(order, requester)) return list;
    return list.map((attempt) => ({
      ...attempt,
      gpsLat: undefined,
      gpsLng: undefined,
    }));
  }

  /**
   * SEC-010 — access instructions ("gate code 4471, unit 12B, dog in the
   * yard") are as sensitive as the address itself and were never redacted.
   * Gated on the same window. The operational instructions a courier needs to
   * do the job at all (pickup/return/laundry-care notes) stay visible.
   */
  instructionsFor(order: OnlineOrder, requester: User): OrderInstructions {
    const instructions = order.instructions ?? {};
    if (this.canSeePreciseLocation(order, requester)) return instructions;
    return { ...instructions, accessInstructions: undefined };
  }

  customerSnapshotFor(order: OnlineOrder, requester: User): CustomerSnapshot {
    const snapshot = order.customer;

    if (this.canSeeCustomerLocation(order, requester)) {
      return {
        ...snapshot,
        areaLabel: snapshot.areaLabel ?? areaLabelOf(snapshot.address),
      };
    }
    // Everyone else — most importantly a courier this order was never
    // assigned to — gets the generalized location only, so list screens still
    // render a "Barangay, City" line without leaking the exact address.
    return {
      uid: snapshot.uid,
      displayName: snapshot.displayName,
      maskedPhone: undefined,
      address: undefined,
      mapLocation: undefined,
      areaLabel: snapshot.areaLabel ?? areaLabelOf(snapshot.address),
    };
  }

  async contactPhoneFor(
    order: OnlineOrder,
    requesterUid: string,
  ): Promise<string | null> {
    if (!activeCourierLeg(order, requesterUid)) return null;
    const customer = await this.userModel
      .findById(order.customer?.uid)
      .select('phoneNumber')
      .lean()
      .exec();
    return customer?.phoneNumber ?? null;
  }

  // A courier's feed, split so the rider app can poll the live half hard and
  // the finished half rarely. The two slices are filtered per LEG, not per
  // order status: a pickup I completed yesterday can sit on an order that is
  // still mid-wash, so "is this order terminal" says nothing about whether my
  // work on it is done.
  //
  // ACTIVE and COMPLETED can both match one order (I did the pickup and am now
  // riding the return). That is intentional — the client merges the feeds by
  // _id before deriving tasks, so the overlap costs one row, not a duplicate.
  async myAssignedTasks(
    courierUid: string,
    scope: CourierTaskScope = CourierTaskScope.ALL,
  ): Promise<OnlineOrder[]> {
    const active = {
      $or: [
        {
          'pickupAssignment.assignedStaffUid': courierUid,
          status: { $in: ASSIGNED_STATUSES.pickup },
        },
        {
          'returnAssignment.assignedStaffUid': courierUid,
          status: { $in: ASSIGNED_STATUSES.return },
        },
      ],
    };

    // Bounded by when the LEG closed, not when the order did — an order can
    // linger for weeks after my part of it ended.
    const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const completed = {
      status: { $nin: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] },
      $or: [
        {
          'pickupAssignment.assignedStaffUid': courierUid,
          'pickupAssignment.completedAt': { $gte: recentCutoff },
        },
        {
          'returnAssignment.assignedStaffUid': courierUid,
          'returnAssignment.completedAt': { $gte: recentCutoff },
        },
      ],
    };

    const filter =
      scope === CourierTaskScope.ACTIVE
        ? active
        : scope === CourierTaskScope.COMPLETED
          ? completed
          : { $or: [active, completed] };

    return this.orderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();
  }

  async orderTimeline(orderId: string): Promise<OrderEvent[]> {
    return this.eventModel.find({ orderId }).sort({ sequence: 1 }).exec();
  }
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  return `${phone.slice(0, 4)}${'*'.repeat(phone.length - 6)}${phone.slice(-2)}`;
}

/** Generalized "Barangay, City" line — the always-visible location grain. */
function areaLabelOf(
  addr?: { barangayName?: string; cityMunicipalityName?: string } | null,
): string | undefined {
  if (!addr) return undefined;
  const label = [addr.barangayName, addr.cityMunicipalityName]
    .filter(Boolean)
    .join(', ');
  return label || undefined;
}
