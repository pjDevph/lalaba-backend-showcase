// GAP-TYPE-002 — the service-line money calculation.
//
// This function used to end in `default: return 0`, and its caller passed
// `pricingType` as `any`. An unrecognised pricing type therefore priced the
// line at ZERO: the order went through free, with nothing thrown and nothing
// logged. Neither producer can emit an unknown value today, so this locks the
// guard in place against the next change rather than fixing a live fault.
//
// The per-model cases below are equally the "existing totals do not move"
// check — they are the arithmetic every current order was priced with.

import { calculateServiceLineTotal } from './pricing.util';
import { PricingType } from '../services/schemas/service.schema';

const params = (
  over: Partial<Parameters<typeof calculateServiceLineTotal>[0]>,
) => ({ pricingType: PricingType.PER_KILO, price: 0, ...over });

describe('calculateServiceLineTotal — every pricing model', () => {
  // Every member of the enum must appear here. If someone adds one, the
  // compile-time `never` check in pricing.util.ts fails first — this is the
  // second line of defence, not the first.
  it('covers every PricingType member', () => {
    const covered = [
      PricingType.PER_KILO,
      PricingType.PER_PIECE,
      PricingType.PER_LOAD,
      PricingType.PER_LOAD_WITH_CAPACITY,
      PricingType.PER_KILO_WITH_BASE,
    ];
    expect(new Set(covered)).toEqual(new Set(Object.values(PricingType)));
  });

  it('PER_KILO — merchant per-kilo rate', () => {
    // 8 kg at ₱95/kg
    expect(
      calculateServiceLineTotal(
        params({ pricingType: PricingType.PER_KILO, price: 9500 }),
        8,
        null,
      ),
    ).toBe(76000);
  });

  it('PER_KILO honours a minimum billable weight', () => {
    // 2 kg billed as the 5 kg minimum
    expect(
      calculateServiceLineTotal(
        params({
          pricingType: PricingType.PER_KILO,
          price: 9500,
          minBillableKg: 5,
        }),
        2,
        null,
      ),
    ).toBe(47500);
  });

  it('PER_PIECE — per-item services', () => {
    expect(
      calculateServiceLineTotal(
        params({ pricingType: PricingType.PER_PIECE, price: 25000 }),
        null,
        3,
      ),
    ).toBe(75000);
  });

  it('PER_LOAD — one flat charge whatever it weighs', () => {
    const flat = params({ pricingType: PricingType.PER_LOAD, price: 18000 });
    expect(calculateServiceLineTotal(flat, 3, null)).toBe(18000);
    expect(calculateServiceLineTotal(flat, 30, null)).toBe(18000);
  });

  it('PER_LOAD_WITH_CAPACITY — washer machine loads, rounded UP', () => {
    // The documented case: a 7 kg machine at ₱180 charges ₱360 for 10 kg.
    const p = params({
      pricingType: PricingType.PER_LOAD_WITH_CAPACITY,
      price: 18000,
      baseKilos: 7,
    });
    expect(calculateServiceLineTotal(p, 7, null)).toBe(18000);
    expect(calculateServiceLineTotal(p, 10, null)).toBe(36000);
  });

  it('PER_KILO_WITH_BASE — base price plus excess', () => {
    // ₱250 covers 5 kg, then ₱40/kg. 8 kg = 250 + 3×40 = ₱370.
    expect(
      calculateServiceLineTotal(
        params({
          pricingType: PricingType.PER_KILO_WITH_BASE,
          price: 25000,
          baseKilos: 5,
          excessRate: 4000,
        }),
        8,
        null,
      ),
    ).toBe(37000);
  });

  it('PER_KILO_WITH_BASE charges only the base under the included weight', () => {
    expect(
      calculateServiceLineTotal(
        params({
          pricingType: PricingType.PER_KILO_WITH_BASE,
          price: 25000,
          baseKilos: 5,
          excessRate: 4000,
        }),
        3,
        null,
      ),
    ).toBe(25000);
  });
});

describe('calculateServiceLineTotal — an unsupported model cannot price at zero', () => {
  // Reaching this needs a cast: the whole point of the fix is that the type
  // system now refuses it. The cast reproduces what `any` used to allow
  // through, and what a legacy stored document could still carry.
  const unsupported = (value: unknown) =>
    ({ pricingType: value, price: 12345 }) as Parameters<
      typeof calculateServiceLineTotal
    >[0];

  it('throws rather than returning 0 for an unknown pricing type', () => {
    expect(() =>
      calculateServiceLineTotal(unsupported('per_fortnight'), 8, null),
    ).toThrow(/Unsupported pricing type/);
  });

  it.each([[undefined], [null], ['']])(
    'throws rather than returning 0 for %p',
    (value) => {
      expect(() =>
        calculateServiceLineTotal(unsupported(value), 8, null),
      ).toThrow(/Unsupported pricing type/);
    },
  );

  it('never returns 0 for a line that has a price', () => {
    // The regression in one line: whatever happens, a priced line must not
    // silently come back free.
    for (const bad of ['per_fortnight', undefined, null, '']) {
      let result: number | null = null;
      try {
        result = calculateServiceLineTotal(unsupported(bad), 8, null);
      } catch {
        continue; // throwing is the correct outcome
      }
      expect(result).not.toBe(0);
    }
  });
});
