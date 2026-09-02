import { BadRequestException } from '@nestjs/common';
import { PricingType } from '../services/schemas/service.schema';
import {
  PRICING_MODEL_TO_TYPE,
  WasherPricingControl,
  WasherPricingModel,
  WasherServiceUnit,
  type WasherServiceTemplate,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import type { WasherServiceOffering } from './schemas/washer-service-offering.schema';

/**
 * The priced shape every consumer needs: the order-line snapshot, the quote,
 * and the customer-facing catalog all take exactly these four fields.
 */
export interface ResolvedWasherPricing {
  pricingType: PricingType;
  price: number;
  baseKilos?: number;
  excessRate?: number;
  minBillableKg?: number;
  /** PER_ITEM only — what the line counts, for display and quantity prompts. */
  unit?: WasherServiceUnit;
  minQuantity?: number;
  maxQuantity?: number;
}

/**
 * The fields any pricing source supplies, whichever side set them. The
 * template and the offering store the same shape under different names —
 * `platformLoadCapacityKg` vs `loadCapacityKg` — so both are normalised into
 * this before pricing, and one switch serves both.
 */
interface PricingSource {
  model: WasherPricingModel;
  priceCentavos: number;
  loadCapacityKg?: number | null;
  baseWeightKg?: number | null;
  excessRatePerKgCentavos?: number | null;
  minBillableKg?: number | null;
  unit?: WasherServiceUnit | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
}

/**
 * Turns one pricing source into the shape the order engine consumes. The ONLY
 * place a WasherPricingModel becomes a PricingType — both the platform's own
 * numbers and a washer's override run through here, so a platform-fixed
 * per-load service and a washer-set one cannot price differently.
 */
function priceFromSource(src: PricingSource): ResolvedWasherPricing {
  switch (src.model) {
    case WasherPricingModel.PER_KG:
      return {
        pricingType: PricingType.PER_KILO,
        price: src.priceCentavos,
        minBillableKg: src.minBillableKg ?? undefined,
      };
    case WasherPricingModel.PER_LOAD:
      return {
        pricingType: PricingType.PER_LOAD_WITH_CAPACITY,
        price: src.priceCentavos,
        // baseKilos carries the load capacity — see ServiceLinePricingParams.
        baseKilos: src.loadCapacityKg ?? undefined,
      };
    case WasherPricingModel.PER_ITEM:
      return {
        pricingType: PricingType.PER_PIECE,
        price: src.priceCentavos,
        unit: src.unit ?? WasherServiceUnit.PIECE,
        minQuantity: src.minQuantity ?? undefined,
        maxQuantity: src.maxQuantity ?? undefined,
      };
    case WasherPricingModel.BASE_EXCESS:
    default:
      return {
        pricingType: PricingType.PER_KILO_WITH_BASE,
        price: src.priceCentavos,
        baseKilos: src.baseWeightKg ?? 0,
        excessRate: src.excessRatePerKgCentavos ?? 0,
        minBillableKg: src.minBillableKg ?? undefined,
      };
  }
}

/**
 * What this washer charges for this service — the ONE place that decides.
 *
 * Resolution order:
 *   1. PLATFORM_FIXED template → always the template's own numbers, even if a
 *      stale offering row exists (a service can be pulled back under platform
 *      control without deleting every washer's price).
 *   2. An offering row → the washer's price.
 *   3. Neither → the template's numbers as the default, which is why washers
 *      who have never opened the pricing editor keep the price they have now.
 */
export function resolveWasherPricing(
  template: PlatformPricedTemplate,
  offering?: WasherServiceOffering | null,
): ResolvedWasherPricing {
  const platformDefault = platformPricingOf(template);

  if (template.pricingControl === WasherPricingControl.PLATFORM_FIXED) {
    return platformDefault;
  }
  if (!offering) return platformDefault;

  return priceFromSource({
    model: offering.pricingModel,
    priceCentavos: offering.priceCentavos,
    loadCapacityKg: offering.loadCapacityKg,
    baseWeightKg: offering.baseWeightKg,
    excessRatePerKgCentavos: offering.excessRatePerKgCentavos,
    minBillableKg: offering.minBillableKg,
    unit: offering.unit,
    minQuantity: offering.minQuantity,
    maxQuantity: offering.maxQuantity,
  });
}

/** The template fields `platformPricingOf` reads. */
export type PlatformPricedTemplate = Pick<
  WasherServiceTemplate,
  | 'pricingControl'
  | 'basePriceCentavos'
  | 'baseWeightKg'
  | 'excessRatePerKgCentavos'
> &
  Partial<
    Pick<
      WasherServiceTemplate,
      | 'platformPricingModel'
      | 'platformLoadCapacityKg'
      | 'platformUnit'
      | 'platformMinBillableKg'
    >
  >;

/**
 * The platform's own numbers for a template, in whichever model it declares.
 *
 * `platformPricingModel` is optional in the type on purpose: templates written
 * before the field existed have no value for it, and Mongoose only applies a
 * schema default on write. Falling back to BASE_EXCESS here is what makes the
 * whole change migration-free — an untouched template resolves to exactly the
 * base + excess price it resolved to before.
 */
export function platformPricingOf(
  template: PlatformPricedTemplate,
): ResolvedWasherPricing {
  return priceFromSource({
    model: template.platformPricingModel ?? WasherPricingModel.BASE_EXCESS,
    priceCentavos: template.basePriceCentavos,
    loadCapacityKg: template.platformLoadCapacityKg,
    baseWeightKg: template.baseWeightKg,
    excessRatePerKgCentavos: template.excessRatePerKgCentavos,
    minBillableKg: template.platformMinBillableKg,
    unit: template.platformUnit,
  });
}

/**
 * Reference weight for comparing offerings that use different charging models.
 * Discovery sorts and filters providers by "price from", which is meaningless
 * across ₱/kg, ₱/load and base+excess — so every model is evaluated at the same
 * basket size and the resulting totals are what get compared.
 *
 * 7 kg is the typical Philippine home-washer machine load and the base weight
 * the seeded catalog already uses, so the number is representative rather than
 * arbitrary.
 */
export const DISCOVERY_REFERENCE_WEIGHT_KG = 7;

/**
 * Whether a resolved price can join the "from ₱X" comparison at all.
 *
 * A per-item service cannot: ₱250 per comforter evaluated against a 7 kg
 * basket is not a smaller or larger number than ₱250 for 7 kg of Wash & Fold,
 * it is a different question. Pricing it at quantity 1 and letting it into the
 * Math.min would let a washer who added comforters appear to be the cheapest
 * washer for ordinary laundry.
 */
export function comparableInDiscovery(pricing: ResolvedWasherPricing): boolean {
  return pricing.pricingType !== PricingType.PER_PIECE;
}

/**
 * Enforces a per-item offering's quantity limits against what the customer
 * actually asked for, at booking time.
 *
 * The limits are the washer's own capacity statement — one curtain panel is
 * not worth a pickup trip, and thirty comforters will not fit in her day. They
 * are validated as configuration when she saves them; this is the other half,
 * without which they are decoration: stored, displayed, and ignored by every
 * order.
 *
 * Only booking is guarded. Recording the ACTUAL count at collection is her own
 * measurement of what turned up, and blocking her from logging eight items
 * because her own maximum says five would leave the order unrecordable.
 */
export function assertQuantityWithinOfferingLimits(
  pricing: Pick<
    ResolvedWasherPricing,
    'pricingType' | 'minQuantity' | 'maxQuantity' | 'unit'
  >,
  requestedCount: number | null | undefined,
  serviceName: string,
): void {
  if (pricing.pricingType !== PricingType.PER_PIECE) return;

  const unit = (pricing.unit ?? WasherServiceUnit.PIECE).toLowerCase();
  const count = requestedCount ?? 0;

  // A per-piece line with no count prices to zero — a free service, not an
  // empty one. This is the floor even when the washer set no minimum.
  if (!Number.isInteger(count) || count < 1) {
    throw new BadRequestException(
      `Choose how many ${unit}s of "${serviceName}" you need.`,
    );
  }
  if (pricing.minQuantity != null && count < pricing.minQuantity) {
    throw new BadRequestException(
      `This washer takes at least ${pricing.minQuantity} ${unit}${
        pricing.minQuantity > 1 ? 's' : ''
      } of "${serviceName}" per booking.`,
    );
  }
  if (pricing.maxQuantity != null && count > pricing.maxQuantity) {
    throw new BadRequestException(
      `This washer can take at most ${pricing.maxQuantity} ${unit}${
        pricing.maxQuantity > 1 ? 's' : ''
      } of "${serviceName}" per booking.`,
    );
  }
}

/**
 * Validates a washer's proposed pricing against the template's policy.
 * Throws BadRequestException with a washer-readable message; returns nothing.
 */
export function assertOfferingAllowed(
  template: Pick<
    WasherServiceTemplate,
    | 'name'
    | 'pricingControl'
    | 'allowedPricingModels'
    | 'minPriceCentavos'
    | 'maxPriceCentavos'
  >,
  input: {
    pricingModel: WasherPricingModel;
    priceCentavos: number;
    loadCapacityKg?: number | null;
    baseWeightKg?: number | null;
    excessRatePerKgCentavos?: number | null;
    minBillableKg?: number | null;
    unit?: WasherServiceUnit | null;
    minQuantity?: number | null;
    maxQuantity?: number | null;
  },
): void {
  if (template.pricingControl === WasherPricingControl.PLATFORM_FIXED) {
    throw new BadRequestException(
      `"${template.name}" is priced by Lalaba — you can offer it, but not set its price.`,
    );
  }

  if (!template.allowedPricingModels?.includes(input.pricingModel)) {
    throw new BadRequestException(
      `"${template.name}" cannot be charged ${describeModel(input.pricingModel)}.`,
    );
  }

  if (!Number.isFinite(input.priceCentavos) || input.priceCentavos <= 0) {
    throw new BadRequestException('Enter a price greater than zero.');
  }

  // Guardrails bound the headline amount, never a computed total — a ₱180 load
  // and a ₱180 base price are the same kind of number to a reviewer.
  const { minPriceCentavos, maxPriceCentavos } = template;
  if (minPriceCentavos != null && input.priceCentavos < minPriceCentavos) {
    throw new BadRequestException(
      `That price is below the ${peso(minPriceCentavos)} minimum Lalaba allows for "${template.name}".`,
    );
  }
  if (maxPriceCentavos != null && input.priceCentavos > maxPriceCentavos) {
    throw new BadRequestException(
      `That price is above the ${peso(maxPriceCentavos)} maximum Lalaba allows for "${template.name}".`,
    );
  }

  // Per-model completeness. Without these a line prices to something the
  // washer never intended: a load with no capacity bills one load for any
  // weight, and base+excess with no rate gives unlimited free kilos.
  if (input.pricingModel === WasherPricingModel.PER_LOAD) {
    if (!input.loadCapacityKg || input.loadCapacityKg <= 0) {
      throw new BadRequestException(
        'Set how many kilos fit in one load, so bigger baskets are charged for the extra loads they need.',
      );
    }
  }
  if (input.pricingModel === WasherPricingModel.BASE_EXCESS) {
    if (input.baseWeightKg == null || input.baseWeightKg < 0) {
      throw new BadRequestException(
        'Set how many kilos the base price covers.',
      );
    }
    if (
      input.excessRatePerKgCentavos == null ||
      input.excessRatePerKgCentavos < 0
    ) {
      throw new BadRequestException(
        'Set the rate for every kilo above the base weight.',
      );
    }
  }
  if (input.pricingModel === WasherPricingModel.PER_ITEM) {
    if (!input.unit) {
      throw new BadRequestException(
        'Choose what you are counting — pieces, pairs, sets or panels.',
      );
    }
    const { minQuantity: min, maxQuantity: max } = input;
    if (min != null && (!Number.isInteger(min) || min < 1)) {
      throw new BadRequestException(
        'The smallest order must be a whole number of at least 1.',
      );
    }
    if (max != null && (!Number.isInteger(max) || max < 1)) {
      throw new BadRequestException(
        'The largest order must be a whole number of at least 1.',
      );
    }
    // Inverted limits reject every quantity a customer could enter, and the
    // two messages each look reasonable in isolation — so say it once, here.
    if (min != null && max != null && min > max) {
      throw new BadRequestException(
        'The smallest order cannot be larger than the largest order.',
      );
    }
  }

  if (input.minBillableKg != null && input.minBillableKg < 0) {
    throw new BadRequestException('Minimum weight cannot be negative.');
  }
}

function describeModel(model: WasherPricingModel): string {
  switch (model) {
    case WasherPricingModel.PER_KG:
      return 'per kilo';
    case WasherPricingModel.PER_LOAD:
      return 'per load';
    case WasherPricingModel.BASE_EXCESS:
      return 'as a base price plus excess';
    case WasherPricingModel.PER_ITEM:
      return 'per item';
    default:
      return 'that way';
  }
}

function peso(centavos: number): string {
  return `₱${(centavos / 100).toFixed(2)}`;
}
