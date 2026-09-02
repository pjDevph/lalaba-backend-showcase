import {
  chargeablePlatformFeeCentavos,
  surchargePlatformFeeCentavos,
  waivablePlatformFeeCentavos,
} from './platform-fee-parts.util';
import type { OrderPricing } from './schemas/online-order.schema';

const pricing = (over: Partial<OrderPricing>) => over as OrderPricing;

describe('platform fee parts', () => {
  it('treats the whole fee as waivable when nothing was surcharged', () => {
    expect(
      waivablePlatformFeeCentavos(pricing({ platformFeeCentavos: 2000 })),
    ).toBe(2000);
  });

  it('excludes a quality surcharge from what a promotion may forgive', () => {
    // ₱20 fee of which ₱5 came from a penalty: a "no platform fee" promotion
    // covers ₱15 and the provider still owes the ₱5.
    const p = pricing({
      platformFeeCentavos: 2500,
      platformFeeSurchargeCentavos: 500,
    });
    expect(waivablePlatformFeeCentavos(p)).toBe(2000);
    expect(surchargePlatformFeeCentavos(p)).toBe(500);
  });

  it('follows the fee UP when the laundry weighs more than estimated', () => {
    // The case a frozen waiver would get wrong. Nothing went wrong here — the
    // customer simply brought more laundry — so the larger fee is still
    // entirely covered.
    const estimated = pricing({ platformFeeCentavos: 2000 });
    const reweighed = pricing({ platformFeeCentavos: 3200 });
    expect(waivablePlatformFeeCentavos(estimated)).toBe(2000);
    expect(waivablePlatformFeeCentavos(reweighed)).toBe(3200);
  });

  it('keeps the surcharge out even after a reprice raises the total', () => {
    expect(
      waivablePlatformFeeCentavos(
        pricing({
          platformFeeCentavos: 3700, // 3200 rule + 500 penalty
          platformFeeSurchargeCentavos: 500,
        }),
      ),
    ).toBe(3200);
  });

  it('reads an order written before the split as fully waivable', () => {
    // Legacy orders have no surcharge figure. Treating the whole fee as
    // waivable matches what they actually were: fee, with no penalty recorded.
    expect(
      waivablePlatformFeeCentavos(pricing({ platformFeeCentavos: 1500 })),
    ).toBe(1500);
  });

  it('never returns a negative amount', () => {
    // Defensive: a surcharge larger than the total should not invent a credit.
    expect(
      waivablePlatformFeeCentavos(
        pricing({
          platformFeeCentavos: 1000,
          platformFeeSurchargeCentavos: 4000,
        }),
      ),
    ).toBe(0);
    expect(
      waivablePlatformFeeCentavos(pricing({ platformFeeCentavos: -50 })),
    ).toBe(0);
  });

  it('handles a missing pricing object', () => {
    expect(waivablePlatformFeeCentavos(null)).toBe(0);
    expect(surchargePlatformFeeCentavos(undefined)).toBe(0);
  });
});

describe('chargeablePlatformFeeCentavos', () => {
  it('is the whole fee when no promotion applied', () => {
    expect(
      chargeablePlatformFeeCentavos(pricing({ platformFeeCentavos: 2000 })),
    ).toBe(2000);
  });

  it('is zero when the fee was fully waived', () => {
    // "No Lalaba fee on this order" — the provider owes nothing, and no money
    // moves in either direction.
    expect(
      chargeablePlatformFeeCentavos(
        pricing({
          platformFeeCentavos: 2000,
          platformFeeDiscountCentavos: 2000,
        }),
      ),
    ).toBe(0);
  });

  it('still charges a penalty the waiver did not cover', () => {
    // ₱20 rule fee waived, ₱5 quality surcharge not. The provider owes ₱5 —
    // the case the whole cause-based split exists for.
    expect(
      chargeablePlatformFeeCentavos(
        pricing({
          platformFeeCentavos: 2500,
          platformFeeSurchargeCentavos: 500,
          platformFeeDiscountCentavos: 2000,
        }),
      ),
    ).toBe(500);
  });

  it('owes nothing rather than a credit if the fee is revised below the waiver', () => {
    // A downward re-weigh after a waiver was granted. The wallet has its own
    // reversal path for money actually taken; this must not invent one.
    expect(
      chargeablePlatformFeeCentavos(
        pricing({
          platformFeeCentavos: 1200,
          platformFeeDiscountCentavos: 2000,
        }),
      ),
    ).toBe(0);
  });

  it('leaves an order written before waivers existed unchanged', () => {
    expect(
      chargeablePlatformFeeCentavos(pricing({ platformFeeCentavos: 1500 })),
    ).toBe(1500);
  });

  it('handles a missing pricing object', () => {
    expect(chargeablePlatformFeeCentavos(null)).toBe(0);
  });
});
