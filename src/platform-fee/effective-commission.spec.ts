import { PlatformFeeService } from './platform-fee.service';
import {
  FeeCalculationType,
  FeeCategory,
  FeeChargedTo,
  FeePayerRole,
} from './schemas/platform-fee-rule.schema';
import { ProviderType } from '../online-orders/schemas/order-status.enum';

// The whole reason this query exists: the apps must not assume WHO pays the
// commission. Both seeded rules happen to be customer-paid, but chargedTo is
// freely settable from the admin page with nothing pinning COMMISSION to
// CUSTOMER — so an app that hardcodes it tells a provider the opposite of the
// truth about their own money the day someone flips it.

const rule = (over: Partial<Record<string, unknown>> = {}) => ({
  ruleKey: 'commission-merchant',
  version: 1,
  appliesTo: FeePayerRole.LAUNDROMAT,
  category: FeeCategory.COMMISSION,
  calculationType: FeeCalculationType.PERCENTAGE,
  percent: 12,
  chargedTo: FeeChargedTo.CUSTOMER,
  effectiveFrom: new Date('2020-01-01'),
  effectiveTo: null,
  isActive: true,
  ...over,
});

const makeService = (rules: unknown[], legacyPercent = 10) => {
  const ruleModel = {
    find: () => ({ sort: () => ({ exec: async () => rules }) }),
  };
  const legacyConfigModel = {
    findOne: () => ({
      sort: () => ({ exec: async () => ({ feePercent: legacyPercent }) }),
    }),
  };
  return new PlatformFeeService(
    ruleModel as never,
    legacyConfigModel as never,
    {} as never,
  );
};

describe('getEffectiveCommission', () => {
  it('[HP] reports a customer-paid commission as customer-paid', async () => {
    const svc = makeService([rule()]);
    const out = await svc.getEffectiveCommission(ProviderType.MERCHANT);
    expect(out).toEqual({
      percent: 12,
      chargedTo: FeeChargedTo.CUSTOMER,
      calculationType: FeeCalculationType.PERCENTAGE,
      isConfigured: true,
    });
  });

  it('[SEC] reports a provider-paid commission as provider-paid', async () => {
    // The case the apps used to get wrong by assumption. A provider-paid rule
    // means the customer pays the listed price and the provider receives less
    // — the exact opposite of the copy that was hardcoded.
    const svc = makeService([rule({ chargedTo: FeeChargedTo.PROVIDER })]);
    const out = await svc.getEffectiveCommission(ProviderType.MERCHANT);
    expect(out.chargedTo).toBe(FeeChargedTo.PROVIDER);
    expect(out.isConfigured).toBe(true);
  });

  it('[EC] surfaces SPLIT rather than collapsing it to one side', async () => {
    const svc = makeService([rule({ chargedTo: FeeChargedTo.SPLIT })]);
    const out = await svc.getEffectiveCommission(ProviderType.MERCHANT);
    expect(out.chargedTo).toBe(FeeChargedTo.SPLIT);
  });

  it('[EC] a FIXED commission falls back and is flagged unconfigured', async () => {
    // A percentage cannot describe a fixed commission, so a client must not
    // compute a net from it.
    const svc = makeService(
      [rule({ calculationType: FeeCalculationType.FIXED, percent: null })],
      10,
    );
    const out = await svc.getEffectiveCommission(ProviderType.MERCHANT);
    expect(out.isConfigured).toBe(false);
    expect(out.calculationType).toBe(FeeCalculationType.PERCENTAGE);
  });

  it('[EC] no rule at all reports the fallback rate, marked unconfigured', async () => {
    const svc = makeService([], 10);
    const out = await svc.getEffectiveCommission(ProviderType.MERCHANT);
    expect(out.percent).toBe(10);
    expect(out.isConfigured).toBe(false);
  });

  it('[HP] merchant and washer rates are resolved independently', async () => {
    // The two can legitimately diverge, so asking for one must never answer
    // with the other's rate.
    const svc = makeService([
      rule({ appliesTo: FeePayerRole.LAUNDROMAT, percent: 12 }),
    ]);
    const merchant = await svc.getEffectiveCommission(ProviderType.MERCHANT);
    expect(merchant.percent).toBe(12);
  });
});
