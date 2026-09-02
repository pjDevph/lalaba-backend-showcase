import { PricingType } from '../services/schemas/service.schema';

export interface ServiceLinePricingParams {
  pricingType: PricingType;
  // Flat price, or PER_KILO/PER_PIECE unit rate, or PER_KILO_WITH_BASE base
  // price, or PER_LOAD_WITH_CAPACITY price-per-load.
  price: number;
  // Kilos included in the base price (PER_KILO_WITH_BASE) or the machine's
  // load capacity (PER_LOAD_WITH_CAPACITY) — both answer "how many kg does
  // `price` cover", so they share the field and the order-line snapshot.
  baseKilos?: number | null;
  excessRate?: number | null;
  /** Weight-based lines bill at least this many kg. */
  minBillableKg?: number | null;
}

/**
 * Computes the price for one service line given the actual measured
 * quantity (weight in kg, or piece count). Shared by Merchant services
 * (self-configured PricingType) and Washer offerings (whichever model the
 * washer picked, within the template's allowed set) so there's one formula,
 * not two.
 */
export function calculateServiceLineTotal(
  params: ServiceLinePricingParams,
  actualWeightKg: number | null,
  actualPieceCount: number | null,
): number {
  switch (params.pricingType) {
    case PricingType.PER_KILO:
      return roundCentavos(
        billableKg(actualWeightKg, params.minBillableKg) * params.price,
      );
    case PricingType.PER_PIECE:
      return roundCentavos((actualPieceCount ?? 0) * params.price);
    case PricingType.PER_LOAD:
      return roundCentavos(params.price);
    case PricingType.PER_LOAD_WITH_CAPACITY:
      return roundCentavos(
        loadsFor(actualWeightKg, params.baseKilos) * params.price,
      );
    case PricingType.PER_KILO_WITH_BASE: {
      const baseKilos = params.baseKilos ?? 0;
      const excessRate = params.excessRate ?? 0;
      const kg = billableKg(actualWeightKg, params.minBillableKg);
      const excessKg = Math.max(0, kg - baseKilos);
      return roundCentavos(params.price + excessKg * excessRate);
    }
  }

  // GAP-TYPE-002. There used to be a `default: return 0` here, and the caller
  // passed `pricingType` as `any` — so an unrecognised pricing type priced the
  // line at ZERO and the order went through free, with nothing logged.
  //
  // Neither producer can emit an unknown value today (the merchant service
  // schema is `required: true, enum: PricingType`; the washer resolver's switch
  // returns a real member on every branch), so this is a guard against the NEXT
  // change rather than a live fault. Two layers, because they fail at different
  // times:
  //
  //   • `never` is the compile-time half. Add a member to PricingType without a
  //     case here and this assignment stops type-checking — the error lands on
  //     the person adding the member, before it can reach money.
  //   • the throw is the runtime half, for data that predates a member or
  //     arrives from outside the type system.
  //
  // Failing loudly is the point. A wrong price is recoverable and gets noticed;
  // a silent ₱0 is neither.
  const unhandled: never = params.pricingType;
  throw new Error(
    `Unsupported pricing type: ${String(unhandled)} — refusing to price this line rather than charging zero.`,
  );
}

/**
 * The weight a line actually bills for. Undefined/zero minimums leave the
 * measured weight untouched, so merchant services (which have no minimum) are
 * unaffected.
 */
export function billableKg(
  actualWeightKg: number | null,
  minBillableKg?: number | null,
): number {
  const kg = actualWeightKg ?? 0;
  if (!minBillableKg || minBillableKg <= 0) return kg;
  return Math.max(kg, minBillableKg);
}

/**
 * Machine loads needed for a weight, rounded up — a part-load still occupies
 * the whole machine. Always at least one: a booking exists, so the washer runs
 * the machine even for 2 kg. Falls back to a single load when the capacity is
 * missing or nonsensical, which keeps a misconfigured offering from pricing at
 * zero.
 */
export function loadsFor(
  actualWeightKg: number | null,
  capacityKg?: number | null,
): number {
  if (!capacityKg || capacityKg <= 0) return 1;
  return Math.max(1, Math.ceil((actualWeightKg ?? 0) / capacityKg));
}

export function roundCentavos(value: number): number {
  return Math.round(value);
}

export function calculatePlatformFee(
  eligibleSubtotalCentavos: number,
  feePercent: number,
): number {
  return roundCentavos(eligibleSubtotalCentavos * (feePercent / 100));
}
