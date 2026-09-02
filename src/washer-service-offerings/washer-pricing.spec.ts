import { BadRequestException } from '@nestjs/common';
import { PricingType } from '../services/schemas/service.schema';
import {
  ALL_PRICING_MODELS,
  EVERY_PRICING_MODEL,
  WasherPricingControl,
  WasherPricingModel,
  WasherServiceUnit,
  type WasherServiceTemplate,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import type { WasherServiceOffering } from './schemas/washer-service-offering.schema';
import {
  assertOfferingAllowed,
  assertQuantityWithinOfferingLimits,
  comparableInDiscovery,
  DISCOVERY_REFERENCE_WEIGHT_KG,
  resolveWasherPricing,
  type ResolvedWasherPricing,
} from './washer-pricing.util';
import {
  calculateServiceLineTotal,
  loadsFor,
} from '../online-orders/pricing.util';

// The seeded "Wash & Fold": ₱250 covers 7 kg, ₱30/kg after.
const template = {
  name: 'Wash & Fold',
  pricingControl: WasherPricingControl.WASHER_SET,
  allowedPricingModels: ALL_PRICING_MODELS,
  minPriceCentavos: null,
  maxPriceCentavos: null,
  basePriceCentavos: 25000,
  baseWeightKg: 7,
  excessRatePerKgCentavos: 3000,
} as unknown as WasherServiceTemplate;

// A per-item service ("Comforter"). Per-item is opt-in, so unlike Wash & Fold
// this template has to name it explicitly in its allow-list.
const itemTemplate = {
  ...template,
  name: 'Comforter',
  allowedPricingModels: EVERY_PRICING_MODEL,
};

const offering = (
  over: Partial<WasherServiceOffering>,
): WasherServiceOffering =>
  ({
    branchId: 'branch-1',
    serviceTemplateId: 'template-1',
    pricingModel: WasherPricingModel.PER_KG,
    priceCentavos: 3500,
    loadCapacityKg: null,
    baseWeightKg: null,
    excessRatePerKgCentavos: null,
    minBillableKg: null,
    ...over,
  }) as WasherServiceOffering;

const priceAt = (
  t: WasherServiceTemplate,
  o: WasherServiceOffering | null,
  kg: number,
) => calculateServiceLineTotal(resolveWasherPricing(t, o), kg, null);

describe('washer pricing resolution', () => {
  describe('fallback to the platform default', () => {
    it('[HP] prices a washer who has never set her own price exactly as before', () => {
      const resolved = resolveWasherPricing(template, null);
      expect(resolved).toEqual({
        pricingType: PricingType.PER_KILO_WITH_BASE,
        price: 25000,
        baseKilos: 7,
        excessRate: 3000,
      });
      // ₱250 + 3 kg × ₱30 = ₱340 — the number the catalog charges today.
      expect(priceAt(template, null, 10)).toBe(34000);
    });

    it('[UT] ignores a stale offering once the service is platform-priced again', () => {
      const platformPriced = {
        ...template,
        pricingControl: WasherPricingControl.PLATFORM_FIXED,
      } as WasherServiceTemplate;
      const own = offering({ priceCentavos: 9900 });
      expect(resolveWasherPricing(platformPriced, own).price).toBe(25000);
    });
  });

  describe('per kg', () => {
    it('[HP] bills the measured weight at the washer rate', () => {
      const own = offering({
        pricingModel: WasherPricingModel.PER_KG,
        priceCentavos: 3500,
      });
      expect(priceAt(template, own, 10)).toBe(35000);
    });

    it('[HP] honours a minimum billable weight without inflating bigger loads', () => {
      const own = offering({
        pricingModel: WasherPricingModel.PER_KG,
        priceCentavos: 3500,
        minBillableKg: 5,
      });
      expect(priceAt(template, own, 2)).toBe(17500); // billed as 5 kg
      expect(priceAt(template, own, 8)).toBe(28000); // above the minimum
    });
  });

  describe('per load', () => {
    const own = offering({
      pricingModel: WasherPricingModel.PER_LOAD,
      priceCentavos: 18000,
      loadCapacityKg: 7,
    });

    it('[HP] rounds up to whole machine loads', () => {
      // The worked example from the design: 10 kg in a 7 kg machine is 2 runs.
      expect(priceAt(template, own, 10)).toBe(36000);
      expect(priceAt(template, own, 7)).toBe(18000);
      expect(priceAt(template, own, 7.1)).toBe(36000);
      expect(priceAt(template, own, 21)).toBe(54000);
    });

    it('[UT] charges one load for a part load, including an unweighed booking', () => {
      expect(priceAt(template, own, 2)).toBe(18000);
      expect(priceAt(template, own, 0)).toBe(18000);
      expect(loadsFor(null, 7)).toBe(1);
    });

    it('[UT] falls back to a single load rather than zero when capacity is missing', () => {
      const broken = offering({
        pricingModel: WasherPricingModel.PER_LOAD,
        priceCentavos: 18000,
        loadCapacityKg: null,
      });
      expect(priceAt(template, broken, 30)).toBe(18000);
    });
  });

  describe('base + excess', () => {
    it('[HP] applies the washer own base and excess, not the template', () => {
      const own = offering({
        pricingModel: WasherPricingModel.BASE_EXCESS,
        priceCentavos: 30000,
        baseWeightKg: 8,
        excessRatePerKgCentavos: 2500,
      });
      // ₱300 + 2 kg × ₱25 = ₱350
      expect(priceAt(template, own, 10)).toBe(35000);
      expect(priceAt(template, own, 8)).toBe(30000);
      expect(priceAt(template, own, 3)).toBe(30000);
    });
  });

  describe('merchant pricing is untouched', () => {
    it('[REG] PER_LOAD still means one flat charge whatever the weight', () => {
      const line = { pricingType: PricingType.PER_LOAD, price: 18000 };
      expect(calculateServiceLineTotal(line, 30, null)).toBe(18000);
      expect(calculateServiceLineTotal(line, 3, null)).toBe(18000);
    });

    it('[REG] PER_KILO with no minimum bills the exact measured weight', () => {
      const line = { pricingType: PricingType.PER_KILO, price: 4000 };
      expect(calculateServiceLineTotal(line, 2.5, null)).toBe(10000);
    });
  });

  describe('discovery comparability', () => {
    it('[HP] compares different charging models at one reference basket', () => {
      const perKg = offering({
        pricingModel: WasherPricingModel.PER_KG,
        priceCentavos: 3500,
      });
      const perLoad = offering({
        pricingModel: WasherPricingModel.PER_LOAD,
        priceCentavos: 18000,
        loadCapacityKg: 7,
      });

      const kgTotal = priceAt(template, perKg, DISCOVERY_REFERENCE_WEIGHT_KG);
      const loadTotal = priceAt(
        template,
        perLoad,
        DISCOVERY_REFERENCE_WEIGHT_KG,
      );

      // ₱35/kg × 7 kg = ₱245 vs ₱180 for one 7 kg load — the per-load washer
      // ranks cheaper. Comparing the headline numbers (3500 vs 18000) would
      // have ranked her as the most expensive on the page.
      expect(kgTotal).toBe(24500);
      expect(loadTotal).toBe(18000);
      expect(loadTotal).toBeLessThan(kgTotal);
    });

    it('[UT] keeps per-item services out of the comparison basket', () => {
      const perItem = resolveWasherPricing(
        itemTemplate,
        offering({
          pricingModel: WasherPricingModel.PER_ITEM,
          priceCentavos: 25000,
          unit: WasherServiceUnit.PIECE,
        }),
      );
      const perKg = resolveWasherPricing(
        template,
        offering({ pricingModel: WasherPricingModel.PER_KG }),
      );

      expect(comparableInDiscovery(perItem)).toBe(false);
      expect(comparableInDiscovery(perKg)).toBe(true);

      // The trap this guards: priced at the 7 kg reference basket a per-piece
      // line bills zero pieces, so it would enter Math.min as ₱0 and make
      // every washer offering comforters the cheapest on the page.
      expect(
        calculateServiceLineTotal(perItem, DISCOVERY_REFERENCE_WEIGHT_KG, null),
      ).toBe(0);
    });
  });
});

// ─── Gap 1: Lalaba's own price is no longer stuck on base + excess ─────────
describe('platform-fixed pricing in every model', () => {
  const fixed = (over: Partial<WasherServiceTemplate>) => ({
    ...template,
    pricingControl: WasherPricingControl.PLATFORM_FIXED,
    ...over,
  });

  it('[REG] a template with no platformPricingModel still prices base + excess', () => {
    // The migration-free guarantee: rows written before the field existed have
    // no value for it, and Mongoose only applies defaults on write.
    const legacy = fixed({});
    delete (legacy as Partial<WasherServiceTemplate>).platformPricingModel;

    expect(resolveWasherPricing(legacy, null)).toEqual({
      pricingType: PricingType.PER_KILO_WITH_BASE,
      price: 25000,
      baseKilos: 7,
      excessRate: 3000,
      minBillableKg: undefined,
    });
    expect(
      calculateServiceLineTotal(resolveWasherPricing(legacy, null), 10, null),
    ).toBe(25000 + 3 * 3000);
  });

  it('[HP] prices a platform per-load service by machine loads', () => {
    const t = fixed({
      platformPricingModel: WasherPricingModel.PER_LOAD,
      basePriceCentavos: 25000,
      platformLoadCapacityKg: 7,
    });
    const resolved = resolveWasherPricing(t, null);
    expect(resolved.pricingType).toBe(PricingType.PER_LOAD_WITH_CAPACITY);
    // 21 kg is three 7 kg loads — ₱750, the preview table in the admin modal.
    expect(calculateServiceLineTotal(resolved, 21, null)).toBe(75000);
    expect(calculateServiceLineTotal(resolved, 7.1, null)).toBe(50000);
  });

  it('[HP] prices a platform per-item service by count', () => {
    const t = fixed({
      platformPricingModel: WasherPricingModel.PER_ITEM,
      basePriceCentavos: 25000,
      platformUnit: WasherServiceUnit.PIECE,
    });
    const resolved = resolveWasherPricing(t, null);
    expect(resolved.pricingType).toBe(PricingType.PER_PIECE);
    expect(resolved.unit).toBe(WasherServiceUnit.PIECE);
    expect(calculateServiceLineTotal(resolved, null, 3)).toBe(75000);
  });

  it('[HP] prices a platform per-kg service at the flat rate', () => {
    const t = fixed({
      platformPricingModel: WasherPricingModel.PER_KG,
      basePriceCentavos: 3500,
      platformMinBillableKg: 3,
    });
    const resolved = resolveWasherPricing(t, null);
    expect(resolved.pricingType).toBe(PricingType.PER_KILO);
    expect(calculateServiceLineTotal(resolved, 10, null)).toBe(35000);
    // Below the minimum, the floor bills — not the measured weight.
    expect(calculateServiceLineTotal(resolved, 1, null)).toBe(10500);
  });

  it('[UT] a platform-fixed template overrides a stale offering in ANY model', () => {
    const t = fixed({
      platformPricingModel: WasherPricingModel.PER_LOAD,
      platformLoadCapacityKg: 7,
      basePriceCentavos: 25000,
    });
    const stale = offering({
      pricingModel: WasherPricingModel.PER_KG,
      priceCentavos: 100,
    });
    // Her ₱1/kg row is ignored, not blended in.
    expect(
      calculateServiceLineTotal(resolveWasherPricing(t, stale), 14, null),
    ).toBe(50000);
  });

  it('[REG] a washer own price still wins over platformPricingModel', () => {
    // The field describes the PLATFORM's price. Once she has set her own, her
    // model decides — a per-load platform figure must not leak into her line.
    const t = {
      ...template,
      platformPricingModel: WasherPricingModel.PER_LOAD,
      platformLoadCapacityKg: 7,
    } as WasherServiceTemplate;
    const hers = offering({
      pricingModel: WasherPricingModel.PER_KG,
      priceCentavos: 3500,
    });
    expect(
      calculateServiceLineTotal(resolveWasherPricing(t, hers), 10, null),
    ).toBe(35000);
  });
});

describe('assertOfferingAllowed', () => {
  const base = {
    pricingModel: WasherPricingModel.PER_KG,
    priceCentavos: 3500,
  };

  it('[HP] accepts a valid offering', () => {
    expect(() => assertOfferingAllowed(template, base)).not.toThrow();
  });

  it('[UT] refuses to price a platform-fixed service', () => {
    const fixed = {
      ...template,
      pricingControl: WasherPricingControl.PLATFORM_FIXED,
    } as WasherServiceTemplate;
    expect(() => assertOfferingAllowed(fixed, base)).toThrow(
      BadRequestException,
    );
  });

  it('[UT] refuses a charging method the template disallows', () => {
    const kgOnly = {
      ...template,
      allowedPricingModels: [WasherPricingModel.PER_KG],
    } as WasherServiceTemplate;
    expect(() =>
      assertOfferingAllowed(kgOnly, {
        pricingModel: WasherPricingModel.PER_LOAD,
        priceCentavos: 18000,
        loadCapacityKg: 7,
      }),
    ).toThrow(/cannot be charged per load/);
  });

  it('[UT] enforces the guardrails on the headline amount', () => {
    const bounded = {
      ...template,
      minPriceCentavos: 2000,
      maxPriceCentavos: 10000,
    } as WasherServiceTemplate;
    expect(() =>
      assertOfferingAllowed(bounded, { ...base, priceCentavos: 1 }),
    ).toThrow(/below the ₱20.00 minimum/);
    expect(() =>
      assertOfferingAllowed(bounded, { ...base, priceCentavos: 99999999 }),
    ).toThrow(/above the ₱100.00 maximum/);
    expect(() =>
      assertOfferingAllowed(bounded, { ...base, priceCentavos: 3500 }),
    ).not.toThrow();
  });

  it('[UT] rejects a free service', () => {
    expect(() =>
      assertOfferingAllowed(template, { ...base, priceCentavos: 0 }),
    ).toThrow(/greater than zero/);
  });

  it('[UT] requires a load capacity for per-load pricing', () => {
    expect(() =>
      assertOfferingAllowed(template, {
        pricingModel: WasherPricingModel.PER_LOAD,
        priceCentavos: 18000,
      }),
    ).toThrow(/how many kilos fit in one load/);
  });

  it('[UT] requires both halves of base + excess', () => {
    expect(() =>
      assertOfferingAllowed(template, {
        pricingModel: WasherPricingModel.BASE_EXCESS,
        priceCentavos: 25000,
        baseWeightKg: 7,
      }),
    ).toThrow(/rate for every kilo/);
    expect(() =>
      assertOfferingAllowed(template, {
        pricingModel: WasherPricingModel.BASE_EXCESS,
        priceCentavos: 25000,
        excessRatePerKgCentavos: 3000,
      }),
    ).toThrow(/how many kilos the base price covers/);
  });

  // ─── Gap 2: per-item ────────────────────────────────────────────────────
  const perItem = {
    pricingModel: WasherPricingModel.PER_ITEM,
    priceCentavos: 25000,
    unit: WasherServiceUnit.PIECE,
  };

  it('[HP] accepts a per-item offering on a template that allows it', () => {
    expect(() => assertOfferingAllowed(itemTemplate, perItem)).not.toThrow();
  });

  it('[REG] per-item is opt-in — the default allow-list refuses it', () => {
    // The guard that stops Wash & Fold, and every template already in the
    // database, from silently becoming priceable per piece.
    expect(ALL_PRICING_MODELS).not.toContain(WasherPricingModel.PER_ITEM);
    expect(() => assertOfferingAllowed(template, perItem)).toThrow(
      /cannot be charged per item/,
    );
  });

  it('[UT] requires a unit for per-item pricing', () => {
    expect(() =>
      assertOfferingAllowed(itemTemplate, { ...perItem, unit: null }),
    ).toThrow(/what you are counting/);
  });

  it('[UT] rejects inverted or fractional quantity limits', () => {
    expect(() =>
      assertOfferingAllowed(itemTemplate, {
        ...perItem,
        minQuantity: 5,
        maxQuantity: 2,
      }),
    ).toThrow(/cannot be larger than/);
    expect(() =>
      assertOfferingAllowed(itemTemplate, { ...perItem, minQuantity: 1.5 }),
    ).toThrow(/whole number/);
    expect(() =>
      assertOfferingAllowed(itemTemplate, { ...perItem, minQuantity: 0 }),
    ).toThrow(/whole number/);
  });

  it('[HP] accepts equal min and max — an exactly-N-items service', () => {
    expect(() =>
      assertOfferingAllowed(itemTemplate, {
        ...perItem,
        minQuantity: 2,
        maxQuantity: 2,
      }),
    ).not.toThrow();
  });

  it('[UT] treats config limits and booking limits as separate checks', () => {
    // assertOfferingAllowed validates what she SAVES; the booking-time check
    // below validates what a customer ASKS FOR. Neither substitutes for the
    // other — that gap is what left the limits unenforced at first.
    expect(() =>
      assertOfferingAllowed(itemTemplate, {
        ...perItem,
        minQuantity: 2,
        maxQuantity: 5,
      }),
    ).not.toThrow();
  });

  it('[UT] still enforces the price guardrails on a per-item amount', () => {
    const bounded = {
      ...itemTemplate,
      maxPriceCentavos: 20000,
    } as WasherServiceTemplate;
    expect(() => assertOfferingAllowed(bounded, perItem)).toThrow(
      /above the ₱200.00 maximum/,
    );
  });
});

// ─── Booking-time quantity limits ──────────────────────────────────────────
describe('assertQuantityWithinOfferingLimits', () => {
  const perItem = (over: Partial<ResolvedWasherPricing> = {}) => ({
    pricingType: PricingType.PER_PIECE,
    price: 25000,
    unit: WasherServiceUnit.PIECE,
    ...over,
  });

  it('[HP] accepts a count inside the washer limits', () => {
    expect(() =>
      assertQuantityWithinOfferingLimits(
        perItem({ minQuantity: 2, maxQuantity: 5 }),
        3,
        'Comforter',
      ),
    ).not.toThrow();
  });

  it('[HP] enforces the limits the washer set', () => {
    const limits = perItem({ minQuantity: 2, maxQuantity: 5 });
    expect(() =>
      assertQuantityWithinOfferingLimits(limits, 1, 'Comforter'),
    ).toThrow(/at least 2 pieces/);
    expect(() =>
      assertQuantityWithinOfferingLimits(limits, 6, 'Comforter'),
    ).toThrow(/at most 5 pieces/);
    // Boundaries are inclusive — "min 2" means 2 is allowed.
    expect(() =>
      assertQuantityWithinOfferingLimits(limits, 2, 'Comforter'),
    ).not.toThrow();
    expect(() =>
      assertQuantityWithinOfferingLimits(limits, 5, 'Comforter'),
    ).not.toThrow();
  });

  it('[UT] rejects a per-item line with no count at all', () => {
    // Without this the line prices at zero pieces — a free service, not an
    // empty one. Applies even when the washer set no minimum.
    for (const bad of [undefined, null, 0, 1.5]) {
      expect(() =>
        assertQuantityWithinOfferingLimits(perItem(), bad, 'Comforter'),
      ).toThrow(/how many pieces/);
    }
  });

  it('[UT] names the washer own unit in the message', () => {
    expect(() =>
      assertQuantityWithinOfferingLimits(
        perItem({ unit: WasherServiceUnit.PAIR, minQuantity: 2 }),
        1,
        'Shoes',
      ),
    ).toThrow(/at least 2 pairs of "Shoes"/);
  });

  it('[REG] ignores every weight-based model', () => {
    // A 1 kg basket must not be read as "one item" and rejected.
    for (const pricingType of [
      PricingType.PER_KILO,
      PricingType.PER_KILO_WITH_BASE,
      PricingType.PER_LOAD_WITH_CAPACITY,
      PricingType.PER_LOAD,
    ]) {
      expect(() =>
        assertQuantityWithinOfferingLimits(
          { pricingType, minQuantity: 2, maxQuantity: 3 },
          undefined,
          'Wash & Fold',
        ),
      ).not.toThrow();
    }
  });
});
