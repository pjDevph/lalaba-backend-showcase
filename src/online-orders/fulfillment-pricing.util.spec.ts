import { BadRequestException } from '@nestjs/common';
import {
  DeliverySubMode,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  TurnaroundTierCode,
} from './schemas/order-status.enum';
import {
  clampLegFee,
  DEFAULT_PREMIUM_WINDOW_FEE_CENTAVOS,
  FulfillmentPricingConfig,
  pickupFeeCentavosFor,
  pickupSlotFeeCentavos,
  resolveFulfillmentFees,
  resolveTurnaround,
  returnFeeCentavosFor,
} from './fulfillment-pricing.util';

const CEILING = 20000; // ₱200

const free: FulfillmentPricingConfig = {
  providerPickup: { feeCentavos: 0, premiumWindowFeeCentavos: 0 },
  providerDelivery: { feeCentavos: 0, premiumWindowFeeCentavos: 0 },
};

const paid: FulfillmentPricingConfig = {
  providerPickup: { feeCentavos: 3000, premiumWindowFeeCentavos: 6000 },
  providerDelivery: { feeCentavos: 5000, premiumWindowFeeCentavos: 8000 },
};

describe('fulfillment pricing — customer-travelled legs', () => {
  it('never charges for a customer drop-off, whatever the provider configured', () => {
    // An invariant, not a default: the provider incurs no logistics cost, so
    // there is nothing to price. A config that says otherwise is ignored.
    expect(
      pickupFeeCentavosFor(
        FulfillmentPickupMode.CUSTOMER_DROPOFF,
        DeliverySubMode.SCHEDULED_PAID,
        paid,
        CEILING,
      ),
    ).toBe(0);
  });

  it('never charges for customer self-pickup', () => {
    expect(
      returnFeeCentavosFor(
        FulfillmentReturnMode.CUSTOMER_SELF_PICKUP,
        DeliverySubMode.SCHEDULED_PAID,
        paid,
        CEILING,
      ),
    ).toBe(0);
  });
});

describe('fulfillment pricing — per-provider fees', () => {
  it('charges the provider’s own base fee on the free-batch tier', () => {
    expect(
      pickupFeeCentavosFor(
        FulfillmentPickupMode.PROVIDER_PICKUP,
        DeliverySubMode.FREE_BATCH,
        paid,
        CEILING,
      ),
    ).toBe(3000);
    expect(
      returnFeeCentavosFor(
        FulfillmentReturnMode.PROVIDER_DELIVERY,
        DeliverySubMode.FREE_BATCH,
        paid,
        CEILING,
      ),
    ).toBe(5000);
  });

  it('charges the premium amount on a paid scheduled window', () => {
    expect(
      pickupFeeCentavosFor(
        FulfillmentPickupMode.PROVIDER_PICKUP,
        DeliverySubMode.SCHEDULED_PAID,
        paid,
        CEILING,
      ),
    ).toBe(6000);
  });

  it('treats zero as free — there is no separate free flag to drift', () => {
    expect(
      returnFeeCentavosFor(
        FulfillmentReturnMode.PROVIDER_DELIVERY,
        DeliverySubMode.FREE_BATCH,
        free,
        CEILING,
      ),
    ).toBe(0);
  });

  it('prices the two legs independently', () => {
    // The whole point of the split: free pickup, paid delivery.
    const config: FulfillmentPricingConfig = {
      providerPickup: { feeCentavos: 0 },
      providerDelivery: { feeCentavos: 5000 },
    };
    const fees = resolveFulfillmentFees({
      pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
      pickupSubMode: DeliverySubMode.FREE_BATCH,
      returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
      deliverySubMode: DeliverySubMode.FREE_BATCH,
      config,
      ceilingCentavos: CEILING,
    });
    expect(fees).toEqual({ pickupFeeCentavos: 0, returnFeeCentavos: 5000 });
  });

  it('inherits the base fee when a configured leg leaves the premium tier null', () => {
    // The provider priced their leg and never touched the premium field — they
    // have not agreed to charge more for it.
    const config: FulfillmentPricingConfig = {
      providerPickup: { feeCentavos: 4000, premiumWindowFeeCentavos: null },
    };
    expect(
      pickupFeeCentavosFor(
        FulfillmentPickupMode.PROVIDER_PICKUP,
        DeliverySubMode.SCHEDULED_PAID,
        config,
        CEILING,
      ),
    ).toBe(4000);
  });
});

describe('fulfillment pricing — unconfigured providers keep v1 behaviour', () => {
  // Most providers have no config document until they open the screen. If this
  // regressed, deploying per-provider pricing would silently re-price them.
  it.each([null, undefined, {}])(
    'prices a free-batch pickup at ₱0 with config %p',
    (config) => {
      expect(
        pickupFeeCentavosFor(
          FulfillmentPickupMode.PROVIDER_PICKUP,
          DeliverySubMode.FREE_BATCH,
          config as FulfillmentPricingConfig,
          CEILING,
        ),
      ).toBe(0);
    },
  );

  it.each([null, undefined, {}])(
    'still charges the platform ₱50 scheduled window with config %p',
    (config) => {
      expect(
        pickupFeeCentavosFor(
          FulfillmentPickupMode.PROVIDER_PICKUP,
          DeliverySubMode.SCHEDULED_PAID,
          config as FulfillmentPricingConfig,
          CEILING,
        ),
      ).toBe(DEFAULT_PREMIUM_WINDOW_FEE_CENTAVOS);
    },
  );
});

describe('fulfillment pricing — platform ceiling', () => {
  it('clamps a provider who asks for more than the platform allows', () => {
    const greedy: FulfillmentPricingConfig = {
      providerDelivery: { feeCentavos: 999_999 },
    };
    expect(
      returnFeeCentavosFor(
        FulfillmentReturnMode.PROVIDER_DELIVERY,
        DeliverySubMode.FREE_BATCH,
        greedy,
        CEILING,
      ),
    ).toBe(CEILING);
  });

  it('applies a ceiling drop to the next order without touching provider docs', () => {
    // Entitlement-style: min(request, ceiling), computed not stored.
    expect(clampLegFee(8000, 5000)).toBe(5000);
    expect(clampLegFee(8000, 20000)).toBe(8000);
  });

  it('floors negative or non-finite requests at zero', () => {
    expect(clampLegFee(-100, CEILING)).toBe(0);
    expect(clampLegFee(Number.NaN, CEILING)).toBe(0);
  });
});

describe('fulfillment pricing — express', () => {
  it('rejects EXPRESS as a pickup tier rather than silently pricing it', () => {
    expect(() =>
      pickupFeeCentavosFor(
        FulfillmentPickupMode.PROVIDER_PICKUP,
        DeliverySubMode.EXPRESS,
        paid,
        CEILING,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects EXPRESS as a delivery sub-mode — speed is a turnaround tier now', () => {
    expect(() =>
      returnFeeCentavosFor(
        FulfillmentReturnMode.PROVIDER_DELIVERY,
        DeliverySubMode.EXPRESS,
        paid,
        CEILING,
      ),
    ).toThrow(BadRequestException);
  });

  it('prices an express turnaround from the provider’s own tier', () => {
    const config: FulfillmentPricingConfig = {
      express: { enabled: true, feeCentavos: 15000, slaHours: 4 },
    };
    expect(
      resolveTurnaround(TurnaroundTierCode.EXPRESS, config, CEILING),
    ).toEqual({
      tierCode: TurnaroundTierCode.EXPRESS,
      feeCentavos: 15000,
      slaHours: 4,
    });
  });

  it('refuses express from a provider who has not enabled it', () => {
    // Never silently downgrade: the customer would pay nothing, be shown
    // "Express", and get standard service with no deadline.
    expect(() =>
      resolveTurnaround(
        TurnaroundTierCode.EXPRESS,
        { express: { enabled: false } },
        CEILING,
      ),
    ).toThrow(BadRequestException);
  });

  it('makes STANDARD free and promises no deadline', () => {
    expect(
      resolveTurnaround(TurnaroundTierCode.STANDARD, paid, CEILING),
    ).toEqual({
      tierCode: TurnaroundTierCode.STANDARD,
      feeCentavos: 0,
      slaHours: null,
    });
  });

  it('clamps an express fee above the platform ceiling', () => {
    const config: FulfillmentPricingConfig = {
      express: { enabled: true, feeCentavos: 999_999, slaHours: 2 },
    };
    expect(
      resolveTurnaround(TurnaroundTierCode.EXPRESS, config, CEILING)
        .feeCentavos,
    ).toBe(CEILING);
  });
});

describe('pickupSlotFeeCentavos — discovery and create agree', () => {
  it('quotes a browsing customer exactly what create will charge', () => {
    const advertised = pickupSlotFeeCentavos(false, paid, CEILING);
    const charged = pickupFeeCentavosFor(
      FulfillmentPickupMode.PROVIDER_PICKUP,
      DeliverySubMode.SCHEDULED_PAID,
      paid,
      CEILING,
    );
    expect(advertised).toBe(charged);
  });

  it('quotes the free tier as free', () => {
    expect(pickupSlotFeeCentavos(true, paid, CEILING)).toBe(3000);
    expect(pickupSlotFeeCentavos(true, free, CEILING)).toBe(0);
  });
});
