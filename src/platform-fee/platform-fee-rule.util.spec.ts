import { BadRequestException } from '@nestjs/common';
import {
  computeFeeCentavos,
  feeRuleKeyFor,
  isRuleInEffect,
  payerRoleForProviderType,
  validateRule,
  type FeeRuleDraft,
} from './platform-fee-rule.util';
import {
  FeeCalculationType,
  FeeChargedTo,
  FeePayerRole,
} from './schemas/platform-fee-rule.schema';
import { ProviderType } from '../online-orders/schemas/order-status.enum';

const PERCENTAGE_10 = {
  calculationType: FeeCalculationType.PERCENTAGE,
  percent: 10,
  fixedAmountCentavos: null,
  minFeeCentavos: null,
  maxFeeCentavos: null,
};

function draft(overrides: Partial<FeeRuleDraft> = {}): FeeRuleDraft {
  return {
    name: 'Platform Commission',
    calculationType: FeeCalculationType.PERCENTAGE,
    percent: 10,
    chargedTo: FeeChargedTo.CUSTOMER,
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

describe('computeFeeCentavos', () => {
  it('takes the percentage of the base', () => {
    expect(computeFeeCentavos(PERCENTAGE_10, 50_000)).toBe(5_000);
  });

  it('ignores the base for a fixed fee', () => {
    const fixed = {
      calculationType: FeeCalculationType.FIXED,
      percent: null,
      fixedAmountCentavos: 1_500,
      minFeeCentavos: null,
      maxFeeCentavos: null,
    };
    expect(computeFeeCentavos(fixed, 50_000)).toBe(1_500);
    expect(computeFeeCentavos(fixed, 0)).toBe(1_500);
  });

  it('adds both parts when the rule is fixed + percentage', () => {
    expect(
      computeFeeCentavos(
        {
          calculationType: FeeCalculationType.FIXED_PLUS_PERCENTAGE,
          percent: 10,
          fixedAmountCentavos: 1_500,
          minFeeCentavos: null,
          maxFeeCentavos: null,
        },
        50_000,
      ),
    ).toBe(6_500);
  });

  // The two worked examples from the spec's minimum/maximum section.
  it('raises a small fee to the minimum', () => {
    expect(
      computeFeeCentavos({ ...PERCENTAGE_10, minFeeCentavos: 500 }, 3_000),
    ).toBe(500); // ₱30 order -> 10% = ₱3 -> floor ₱5
  });

  it('caps a large fee at the maximum', () => {
    expect(
      computeFeeCentavos({ ...PERCENTAGE_10, maxFeeCentavos: 10_000 }, 200_000),
    ).toBe(10_000); // ₱2,000 order -> 10% = ₱200 -> cap ₱100
  });

  it('rounds to whole centavos rather than carrying fractions', () => {
    // 333 * 0.10 = 33.3
    expect(computeFeeCentavos(PERCENTAGE_10, 333)).toBe(33);
  });
});

describe('isRuleInEffect', () => {
  const at = new Date('2026-08-14T00:00:00Z');
  const base = {
    isActive: true,
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    effectiveUntil: null,
  };

  it('is in effect inside an open-ended window', () => {
    expect(isRuleInEffect(base, at)).toBe(true);
  });

  it('is not in effect before it starts — this is what makes scheduling work', () => {
    expect(
      isRuleInEffect(
        { ...base, effectiveFrom: new Date('2026-09-01T00:00:00Z') },
        at,
      ),
    ).toBe(false);
  });

  it('is not in effect once it has ended', () => {
    expect(
      isRuleInEffect(
        { ...base, effectiveUntil: new Date('2026-08-10T00:00:00Z') },
        at,
      ),
    ).toBe(false);
  });

  it('is not in effect while deactivated', () => {
    expect(isRuleInEffect({ ...base, isActive: false }, at)).toBe(false);
  });
});

describe('validateRule', () => {
  it('accepts a plain percentage commission', () => {
    expect(() => validateRule(draft())).not.toThrow();
  });

  it('rejects a percentage rule with no percentage', () => {
    expect(() => validateRule(draft({ percent: null }))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a fixed amount left behind on a percentage rule', () => {
    expect(() => validateRule(draft({ fixedAmountCentavos: 1_500 }))).toThrow(
      /clear the fixed amount/i,
    );
  });

  it('rejects a maximum below the minimum', () => {
    expect(() =>
      validateRule(draft({ minFeeCentavos: 10_000, maxFeeCentavos: 5_000 })),
    ).toThrow(/greater than the minimum/i);
  });

  it('rejects a split that does not total 100%', () => {
    expect(() =>
      validateRule(
        draft({
          chargedTo: FeeChargedTo.SPLIT,
          customerSharePercent: 40,
          providerSharePercent: 40,
        }),
      ),
    ).toThrow(/total 100%/i);
  });

  it('accepts a split that totals 100%', () => {
    expect(() =>
      validateRule(
        draft({
          chargedTo: FeeChargedTo.SPLIT,
          customerSharePercent: 40,
          providerSharePercent: 60,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects shares on a rule that is not split', () => {
    expect(() => validateRule(draft({ customerSharePercent: 40 }))).toThrow(
      /only apply to a fee split/i,
    );
  });

  it('rejects VAT switched on with no rate', () => {
    expect(() => validateRule(draft({ applyVat: true }))).toThrow(
      /needs a VAT rate/i,
    );
  });

  it('rejects an end date on or before the start date', () => {
    expect(() =>
      validateRule(draft({ effectiveUntil: new Date('2026-07-01T00:00:00Z') })),
    ).toThrow(/after the start date/i);
  });
});

describe('rule identity', () => {
  it('slugs the name and suffixes the payer, so the same name for two payers is two rules', () => {
    expect(feeRuleKeyFor('Platform Commission', FeePayerRole.HOME_WASHER)).toBe(
      'platform-commission-washer',
    );
    expect(feeRuleKeyFor('Platform Commission', FeePayerRole.LAUNDROMAT)).toBe(
      'platform-commission-merchant',
    );
  });

  it('maps provider types onto payer roles', () => {
    expect(payerRoleForProviderType(ProviderType.WASHER)).toBe(
      FeePayerRole.HOME_WASHER,
    );
    expect(payerRoleForProviderType(ProviderType.MERCHANT)).toBe(
      FeePayerRole.LAUNDROMAT,
    );
  });
});
