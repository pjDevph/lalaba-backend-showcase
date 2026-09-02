import { BadRequestException } from '@nestjs/common';
import {
  DeliverySubMode,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  TurnaroundTierCode,
} from './schemas/order-status.enum';

/**
 * Server-authoritative pickup/return fulfillment fees (GAP-P0-005).
 *
 * Resolves DECISION_REQUIRED-001 as option (c): the fare is **provider-set,
 * flat, per leg, bounded by a platform ceiling**. It replaces the platform-wide
 * constants that used to live in fulfillment-fees.constants.ts, where a single
 * ₱0/₱50/₱120 table applied to every provider in the marketplace and no washer
 * or laundromat could price their own delivery.
 *
 * The two axes are deliberately independent:
 *   WHICH LEG   — inbound (provider collects) vs outbound (provider returns).
 *                 Configured per provider; either can be free.
 *   WHICH TIER  — the free batch route vs a paid scheduled window. The customer
 *                 picks this by choosing a slot; the provider sets both amounts.
 *
 * Customer-travelled legs are hard zero and not configurable: when the customer
 * drops off or collects, the provider incurs no logistics cost, so there is
 * nothing to price. That is an invariant, not a default.
 *
 * Money is integer centavos throughout.
 */

/** Bump when a fee value's MEANING or the formula changes — not when a provider
 * edits their own price (that is data, and is captured by the snapshot below).
 * Snapshotted onto every order so a later rule change never rewrites old ones. */
export const PRICING_RULE_VERSION = 'fulfillment-fees-v2';

/**
 * Fees for orders placed before per-provider pricing existed, and for any
 * provider who has not set their own. These are the values the v1 constants
 * shipped, so an unconfigured provider prices exactly as they did yesterday.
 */
export const DEFAULT_LEG_FEE_CENTAVOS = 0;
export const DEFAULT_PREMIUM_WINDOW_FEE_CENTAVOS = 5000; // ₱50
/** Express return. Still platform-wide — Phase 3 moves it to a turnaround tier. */
export const RETURN_FEE_EXPRESS_CENTAVOS = 12000; // ₱120

/** The platform's per-leg ceiling when no policy has ever been published. */
export const DEFAULT_MAX_LEG_FEE_CENTAVOS = 20000; // ₱200

/** What a provider asks to charge for one leg. Both amounts are optional. */
export interface LegPricing {
  /** Base fee — the free-batch tier. 0 means free; there is no separate flag. */
  feeCentavos?: number | null;
  /** Paid scheduled window. Null inherits `feeCentavos`. */
  premiumWindowFeeCentavos?: number | null;
}

/** The provider's optional paid turnaround promise. */
export interface TurnaroundTierPricing {
  enabled?: boolean;
  feeCentavos?: number | null;
  slaHours?: number | null;
}

export interface FulfillmentPricingConfig {
  providerPickup?: LegPricing | null;
  providerDelivery?: LegPricing | null;
  express?: TurnaroundTierPricing | null;
}

export interface ResolvedTurnaround {
  tierCode: TurnaroundTierCode;
  feeCentavos: number;
  slaHours: number | null;
}

/**
 * Prices the turnaround promise. STANDARD is always available and always free —
 * it promises nothing, so there is nothing to charge for.
 *
 * Asking for EXPRESS from a provider who has not enabled it is refused rather
 * than silently downgraded: the customer would otherwise pay nothing, be shown
 * "Express", and receive standard service with no deadline.
 */
export function resolveTurnaround(
  tier: TurnaroundTierCode | null | undefined,
  config: FulfillmentPricingConfig | null | undefined,
  ceilingCentavos: number = DEFAULT_MAX_LEG_FEE_CENTAVOS,
): ResolvedTurnaround {
  if (tier !== TurnaroundTierCode.EXPRESS) {
    return {
      tierCode: TurnaroundTierCode.STANDARD,
      feeCentavos: 0,
      slaHours: null,
    };
  }

  const express = config?.express;
  if (!express?.enabled) {
    throw new BadRequestException(
      'This provider does not offer express turnaround.',
    );
  }
  return {
    tierCode: TurnaroundTierCode.EXPRESS,
    feeCentavos: clampLegFee(
      express.feeCentavos ?? RETURN_FEE_EXPRESS_CENTAVOS,
      ceilingCentavos,
    ),
    slaHours: express.slaHours ?? null,
  };
}

export interface ResolvedFulfillmentFees {
  pickupFeeCentavos: number;
  returnFeeCentavos: number;
}

/**
 * min(requested, ceiling), floored at zero.
 *
 * The provider states a request and the platform states an allowance — the same
 * doctrine as `dailyBookingLimit`, so a ceiling drop takes effect on the next
 * order without rewriting a single provider document.
 */
export function clampLegFee(
  requested: number,
  ceilingCentavos: number,
): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(Math.round(requested), ceilingCentavos);
}

/**
 * The amount for one leg at one tier, before clamping.
 *
 * The absent-config case matters more than it looks. Every provider without a
 * `booking_availability_configs` document — which is most of them until they
 * open the screen — falls here, and returning 0 for the premium tier would
 * silently drop the ₱50 scheduled-window fee the platform charges today. So an
 * unconfigured provider keeps exactly the v1 behaviour, and only an explicit
 * provider edit changes a price.
 *
 * Once a leg IS configured, a null premium inherits the base rather than the
 * platform default: a provider who set their base fee and left the premium
 * field alone has not agreed to charge ₱50 on top.
 */
function legAmount(
  leg: LegPricing | null | undefined,
  premium: boolean,
): number {
  if (!leg) {
    return premium
      ? DEFAULT_PREMIUM_WINDOW_FEE_CENTAVOS
      : DEFAULT_LEG_FEE_CENTAVOS;
  }
  const base = leg.feeCentavos ?? DEFAULT_LEG_FEE_CENTAVOS;
  if (!premium) return base;
  return leg.premiumWindowFeeCentavos ?? base;
}

/**
 * Pickup fee for the chosen mode + slot tier.
 *
 * EXPRESS is rejected rather than defaulted: it is a return-speed tier, and a
 * pickup cannot be "express" — silently pricing it as a batch pickup would let
 * a malformed client book a tier that does not exist.
 */
export function pickupFeeCentavosFor(
  pickupMode: FulfillmentPickupMode,
  pickupSubMode: DeliverySubMode | null | undefined,
  config: FulfillmentPricingConfig | null | undefined,
  ceilingCentavos: number = DEFAULT_MAX_LEG_FEE_CENTAVOS,
): number {
  if (pickupMode === FulfillmentPickupMode.CUSTOMER_DROPOFF) return 0;

  const tier = pickupSubMode ?? DeliverySubMode.FREE_BATCH;
  if (tier === DeliverySubMode.EXPRESS) {
    throw new BadRequestException(
      'Express is not a valid pickup option — choose a free batch or scheduled paid pickup window',
    );
  }

  const premium = tier === DeliverySubMode.SCHEDULED_PAID;
  return clampLegFee(
    legAmount(config?.providerPickup, premium),
    ceilingCentavos,
  );
}

/**
 * Return fee for the chosen mode + delivery sub-mode. Self-pickup is always
 * free — the customer travels.
 */
export function returnFeeCentavosFor(
  returnMode: FulfillmentReturnMode,
  deliverySubMode: DeliverySubMode | null | undefined,
  config: FulfillmentPricingConfig | null | undefined,
  ceilingCentavos: number = DEFAULT_MAX_LEG_FEE_CENTAVOS,
): number {
  if (returnMode === FulfillmentReturnMode.CUSTOMER_SELF_PICKUP) return 0;

  const tier = deliverySubMode ?? DeliverySubMode.FREE_BATCH;
  if (tier === DeliverySubMode.EXPRESS) {
    // Speed is a turnaround promise now, not a delivery mode. Rejected on WRITE
    // (here); placed orders still READ fine because their fee is snapshotted.
    throw new BadRequestException(
      'Express is no longer a delivery option — choose an express turnaround instead.',
    );
  }

  const premium = tier === DeliverySubMode.SCHEDULED_PAID;
  return clampLegFee(
    legAmount(config?.providerDelivery, premium),
    ceilingCentavos,
  );
}

/** Both legs at once — what createOrder and quoteOrder each need. */
export function resolveFulfillmentFees(args: {
  pickupMode?: FulfillmentPickupMode | null;
  pickupSubMode?: DeliverySubMode | null;
  returnMode?: FulfillmentReturnMode | null;
  deliverySubMode?: DeliverySubMode | null;
  config: FulfillmentPricingConfig | null | undefined;
  ceilingCentavos?: number;
}): ResolvedFulfillmentFees {
  const ceiling = args.ceilingCentavos ?? DEFAULT_MAX_LEG_FEE_CENTAVOS;
  return {
    pickupFeeCentavos: args.pickupMode
      ? pickupFeeCentavosFor(
          args.pickupMode,
          args.pickupSubMode,
          args.config,
          ceiling,
        )
      : 0,
    returnFeeCentavos: args.returnMode
      ? returnFeeCentavosFor(
          args.returnMode,
          args.deliverySubMode,
          args.config,
          ceiling,
        )
      : 0,
  };
}

/**
 * The fee a customer would be quoted for one pickup window, used by discovery's
 * slot list. Kept here so the price advertised while browsing and the price
 * charged at create come from one function — they used to be two independent
 * literals (`isBatch ? 0 : 5000` in discovery.service.ts vs the constants file),
 * which is exactly how an advertised price drifts from a charged one.
 */
export function pickupSlotFeeCentavos(
  isFreeBatchWindow: boolean,
  config: FulfillmentPricingConfig | null | undefined,
  ceilingCentavos: number = DEFAULT_MAX_LEG_FEE_CENTAVOS,
): number {
  return pickupFeeCentavosFor(
    FulfillmentPickupMode.PROVIDER_PICKUP,
    isFreeBatchWindow
      ? DeliverySubMode.FREE_BATCH
      : DeliverySubMode.SCHEDULED_PAID,
    config,
    ceilingCentavos,
  );
}
