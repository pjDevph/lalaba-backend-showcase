/**
 * PER-PROVIDER FULFILLMENT PRICING, END TO END.
 *
 * Resolves DECISION_REQUIRED-001 as option (c): each provider sets their own
 * flat pickup/delivery fees, bounded by a platform ceiling. Before this, the
 * fees were compile-time constants and no washer or laundromat could price
 * their own delivery at all — GAP-P0-005 was blocked on exactly this question.
 *
 * The unit suite (fulfillment-pricing.util.spec.ts) verifies the arithmetic.
 * What only an e2e can prove is that the provider's mutation is reachable and
 * role-gated, that the pricing path actually reads what was saved, that the
 * QUOTE a customer is shown equals the ORDER they are charged, and that a
 * provider changing their prices afterwards cannot re-price a placed order.
 */
import { Types } from 'mongoose';
import { createE2EApp, E2EContext } from './utils/e2e-app';
import {
  gql,
  gqlOk,
  firstErrorMessage,
  seedUser,
  seedWasher,
  seedWallet,
  seedAddress,
} from './utils/seed';

const ACTIVATED_BALANCE = 100_000; // ₱1,000 — clears the booking-eligibility gate
const SERVICE_PRICE = 20_000; // ₱200 base

const SET_PRICING = /* GraphQL */ `
  mutation SetPricing($branchId: ID, $input: UpdateFulfillmentPricingInput!) {
    updateMyFulfillmentPricing(branchId: $branchId, input: $input) {
      branchId
      fulfillmentPricing {
        providerPickup {
          feeCentavos
          premiumWindowFeeCentavos
        }
        providerDelivery {
          feeCentavos
          premiumWindowFeeCentavos
        }
      }
    }
  }
`;

const PUBLISH_POLICY = /* GraphQL */ `
  mutation Publish($input: PublishBookingPolicyInput!) {
    publishBookingPolicy(input: $input) {
      version
      safetyLimits {
        maxLegFeeCentavos
      }
    }
  }
`;

const QUOTE = /* GraphQL */ `
  query Quote($input: QuoteOrderInput!) {
    quoteOnlineOrder(input: $input) {
      serviceSubtotalCentavos
      pickupFeeCentavos
      returnFeeCentavos
      customerTotalCentavos
    }
  }
`;

const CREATE_ORDER = /* GraphQL */ `
  mutation Create($input: CreateOnlineOrderInput!) {
    createOnlineOrder(input: $input) {
      _id
      pricing {
        pickupFeeCentavos
        returnFeeCentavos
        turnaroundFeeCentavos
        estimatedTotalCentavos
        pricingRuleVersion
      }
    }
  }
`;

const ORDER = /* GraphQL */ `
  query Order($id: ID!) {
    onlineOrder(id: $id) {
      pricing {
        pickupFeeCentavos
        returnFeeCentavos
      }
    }
  }
`;

describe('Per-provider fulfillment pricing (e2e)', () => {
  let ctx: E2EContext;
  let server: unknown;
  let adminUid: string;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer();
    adminUid = await seedUser(ctx.connection, 'admin');
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function seedProvider() {
    const templateId = await seedWasherTemplate(ctx, SERVICE_PRICE);
    const { branchId, ownerUid } = await seedWasher(ctx.connection, {
      verificationStatus: 'APPROVED',
      offeredServiceTemplateIds: [templateId],
    });
    await seedWallet(ctx.connection, branchId, ACTIVATED_BALANCE, true);
    const customerUid = await seedUser(ctx.connection, 'customer');
    const addressId = await seedAddress(ctx.connection, customerUid);
    return { templateId, branchId, ownerUid, customerUid, addressId };
  }

  // scheduledPickup became REQUIRED on CreateOrderInput when booking
  // availability landed; this suite was never updated, so every case here has
  // been failing on "Field \"scheduledPickup\" ... was not provided" since.
  // Only `date` is non-null on ScheduledPickupInput, and this suite is about
  // fulfillment pricing, not slot capacity.
  const SCHEDULED_PICKUP = {
    date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };

  const orderInput = (
    templateId: string,
    branchId: string,
    addressId: string,
  ) => ({
    branchId,
    providerType: 'WASHER',
    addressId,
    serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
    pickupMode: 'PROVIDER_PICKUP',
    returnMode: 'PROVIDER_DELIVERY',
    scheduledPickup: SCHEDULED_PICKUP,
  });

  it('charges the fees the provider set, not a platform-wide constant', async () => {
    const { templateId, branchId, ownerUid, customerUid, addressId } =
      await seedProvider();

    // Free pickup, ₱50 delivery — the washer case from the requirement.
    await gqlOk(
      server,
      SET_PRICING,
      {
        input: {
          providerPickup: { feeCentavos: 0, premiumWindowFeeCentavos: 0 },
          providerDelivery: {
            feeCentavos: 5000,
            premiumWindowFeeCentavos: 5000,
          },
        },
      },
      ownerUid,
    );

    const created = await gqlOk<{
      createOnlineOrder: { pricing: Record<string, number | string> };
    }>(
      server,
      CREATE_ORDER,
      { input: orderInput(templateId, branchId, addressId) },
      customerUid,
    );

    const p = created.createOnlineOrder.pricing;
    expect(p.pickupFeeCentavos).toBe(0);
    expect(p.returnFeeCentavos).toBe(5000);
    expect(p.pricingRuleVersion).toBe('fulfillment-fees-v2');
  });

  it('prices two providers differently for the identical service', async () => {
    // The claim per-provider pricing actually makes: same order, two prices.
    const cheap = await seedProvider();
    const dear = await seedProvider();

    await gqlOk(
      server,
      SET_PRICING,
      { input: { providerDelivery: { feeCentavos: 0 } } },
      cheap.ownerUid,
    );
    await gqlOk(
      server,
      SET_PRICING,
      { input: { providerDelivery: { feeCentavos: 9000 } } },
      dear.ownerUid,
    );

    const quoteFor = async (p: Awaited<ReturnType<typeof seedProvider>>) => {
      const res = await gqlOk<{
        quoteOnlineOrder: Record<string, number>;
      }>(
        server,
        QUOTE,
        {
          input: {
            branchId: p.branchId,
            providerType: 'WASHER',
            serviceLines: [
              { serviceRefId: p.templateId, estimatedWeightKg: 5 },
            ],
            pickupMode: 'PROVIDER_PICKUP',
            returnMode: 'PROVIDER_DELIVERY',
          },
        },
        p.customerUid,
      );
      return res.quoteOnlineOrder;
    };

    const cheapQuote = await quoteFor(cheap);
    const dearQuote = await quoteFor(dear);

    expect(cheapQuote.returnFeeCentavos).toBe(0);
    expect(dearQuote.returnFeeCentavos).toBe(9000);
    expect(
      dearQuote.customerTotalCentavos - cheapQuote.customerTotalCentavos,
    ).toBe(9000);
  });

  it('quotes exactly what it charges', async () => {
    // The invariant money-integrity exists to protect, now that the fee varies
    // per provider: quote and create must read the same configuration.
    const { templateId, branchId, ownerUid, customerUid, addressId } =
      await seedProvider();
    await gqlOk(
      server,
      SET_PRICING,
      {
        input: {
          providerPickup: { feeCentavos: 2500 },
          providerDelivery: { feeCentavos: 7500 },
        },
      },
      ownerUid,
    );

    const quote = await gqlOk<{ quoteOnlineOrder: Record<string, number> }>(
      server,
      QUOTE,
      {
        input: {
          branchId,
          providerType: 'WASHER',
          serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
          pickupMode: 'PROVIDER_PICKUP',
          returnMode: 'PROVIDER_DELIVERY',
        },
      },
      customerUid,
    );
    const created = await gqlOk<{
      createOnlineOrder: { pricing: Record<string, number> };
    }>(
      server,
      CREATE_ORDER,
      { input: orderInput(templateId, branchId, addressId) },
      customerUid,
    );

    const q = quote.quoteOnlineOrder;
    const p = created.createOnlineOrder.pricing;
    expect(p.pickupFeeCentavos).toBe(q.pickupFeeCentavos);
    expect(p.returnFeeCentavos).toBe(q.returnFeeCentavos);
    expect(p.estimatedTotalCentavos).toBe(q.customerTotalCentavos);
  });

  it('clamps a provider who asks above the platform ceiling', async () => {
    const { templateId, branchId, ownerUid, customerUid, addressId } =
      await seedProvider();

    await gqlOk(
      server,
      PUBLISH_POLICY,
      { input: { safetyLimits: { maxLegFeeCentavos: 6000 } } },
      adminUid,
    );
    // Saving an over-ceiling request is allowed — it is a request, like
    // dailyBookingLimit. The clamp happens when the order is priced.
    await gqlOk(
      server,
      SET_PRICING,
      { input: { providerDelivery: { feeCentavos: 50_000 } } },
      ownerUid,
    );

    const created = await gqlOk<{
      createOnlineOrder: { pricing: Record<string, number> };
    }>(
      server,
      CREATE_ORDER,
      { input: orderInput(templateId, branchId, addressId) },
      customerUid,
    );
    expect(created.createOnlineOrder.pricing.returnFeeCentavos).toBe(6000);
  });

  it('does not re-price a placed order when the provider changes their fees', async () => {
    const { templateId, branchId, ownerUid, customerUid, addressId } =
      await seedProvider();
    await gqlOk(
      server,
      SET_PRICING,
      { input: { providerDelivery: { feeCentavos: 3000 } } },
      ownerUid,
    );

    const created = await gqlOk<{
      createOnlineOrder: { _id: string; pricing: Record<string, number> };
    }>(
      server,
      CREATE_ORDER,
      { input: orderInput(templateId, branchId, addressId) },
      customerUid,
    );
    const orderId = created.createOnlineOrder._id;
    expect(created.createOnlineOrder.pricing.returnFeeCentavos).toBe(3000);

    await gqlOk(
      server,
      SET_PRICING,
      { input: { providerDelivery: { feeCentavos: 9999 } } },
      ownerUid,
    );

    const after = await gqlOk<{
      onlineOrder: { pricing: Record<string, number> };
    }>(server, ORDER, { id: orderId }, customerUid);
    // The fee is snapshotted, so yesterday's order keeps yesterday's price.
    expect(after.onlineOrder.pricing.returnFeeCentavos).toBe(3000);
  });

  it('charges an express turnaround on top, independent of the delivery leg', async () => {
    const { templateId, branchId, ownerUid, customerUid, addressId } =
      await seedProvider();
    // The booking policy is a single global LIVE record, so an earlier case's
    // ceiling would otherwise clamp this one. Stated explicitly here — the
    // ceiling bounds the turnaround fee too, not just the transport legs.
    await gqlOk(
      server,
      PUBLISH_POLICY,
      { input: { safetyLimits: { maxLegFeeCentavos: 20000 } } },
      adminUid,
    );
    await gqlOk(
      server,
      SET_PRICING,
      {
        input: {
          providerDelivery: { feeCentavos: 0 },
          express: { enabled: true, feeCentavos: 15000, slaHours: 4 },
        },
      },
      ownerUid,
    );

    const created = await gqlOk<{
      createOnlineOrder: { pricing: Record<string, number> };
    }>(
      server,
      CREATE_ORDER,
      {
        input: {
          ...orderInput(templateId, branchId, addressId),
          // Self-pickup: free to travel, but still buying speed. This
          // combination was impossible while express was a delivery mode.
          returnMode: 'CUSTOMER_SELF_PICKUP',
          turnaroundTier: 'EXPRESS',
        },
      },
      customerUid,
    );
    const p = created.createOnlineOrder.pricing;
    expect(p.returnFeeCentavos).toBe(0);
    expect(p.turnaroundFeeCentavos).toBe(15000);
  });

  it('refuses express from a provider who has not enabled it', async () => {
    const { templateId, branchId, customerUid, addressId } =
      await seedProvider();
    const res = await gql(
      server,
      CREATE_ORDER,
      {
        input: {
          ...orderInput(templateId, branchId, addressId),
          turnaroundTier: 'EXPRESS',
        },
      },
      customerUid,
    );
    expect(firstErrorMessage(res)).toMatch(/express/i);
  });

  it('refuses EXPRESS as a delivery sub-mode now that speed is a tier', async () => {
    const { templateId, branchId, customerUid, addressId } =
      await seedProvider();
    const res = await gql(
      server,
      CREATE_ORDER,
      {
        input: {
          ...orderInput(templateId, branchId, addressId),
          deliverySubMode: 'EXPRESS',
        },
      },
      customerUid,
    );
    expect(firstErrorMessage(res)).toMatch(/express/i);
  });

  it('refuses to let a customer set a provider’s prices', async () => {
    const { customerUid } = await seedProvider();
    const res = await gql(
      server,
      SET_PRICING,
      { input: { providerDelivery: { feeCentavos: 0 } } },
      customerUid,
    );
    expect(firstErrorMessage(res)).toBeTruthy();
  });
});

/** Same shape as the seeder in booking-and-fee-config.e2e-spec.ts. */
async function seedWasherTemplate(
  ctx: E2EContext,
  basePriceCentavos: number,
): Promise<string> {
  const _id = new Types.ObjectId();
  await ctx.connection.collection('washer_service_templates').insertOne({
    _id,
    name: `E2E Wash ${Date.now()}${Math.floor(Math.random() * 1000)}`,
    description: null,
    pricingControl: 'washer_set',
    allowedPricingModels: ['per_kg', 'per_load', 'base_excess'],
    minPriceCentavos: null,
    maxPriceCentavos: null,
    basePriceCentavos,
    baseWeightKg: 5,
    excessRatePerKgCentavos: 2_000,
    turnaroundHours: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return String(_id);
}
