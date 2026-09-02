/**
 * MONEY INTEGRITY, end to end.
 *
 * Two halves, both of which unit tests structurally cannot cover:
 *
 * 1. quote -> create -> accept -> collect, asserting exact centavo equality
 *    across the three stages including pickup/return fulfillment fees. The
 *    numbers are recomputed independently in this file rather than read back
 *    from the same helper the service uses, so an arithmetic change on either
 *    side breaks the test.
 *
 * 2. The Xendit webhook, driven over real HTTP (which is where defect #2 killed
 *    it entirely): a duplicate delivery credits exactly once, and a forged
 *    reference never credits. This is the ONLY path that can add money to a
 *    provider wallet, so both properties are load-bearing.
 */
import request from 'supertest';
import { Types } from 'mongoose';
import { createE2EApp, E2EContext } from './utils/e2e-app';
import {
  gql,
  gqlOk,
  firstErrorMessage,
  seedUser,
  seedMerchantBranch,
  seedWallet,
  seedService,
  seedAddress,
} from './utils/seed';

const WEBHOOK_PATH = '/webhooks/xendit';
const VALID_TOKEN = 'e2e-callback-token';

// Independent restatement of the shipped constants. If a product change moves
// a fee, this test must be updated deliberately — that is the point.
//
// These are now the fees an UNCONFIGURED provider is charged: fulfillment
// pricing became per-provider (DECISION_REQUIRED-001 option c), and a provider
// who has never set their own prices must still be priced exactly as the old
// platform-wide constants did. That guarantee is what these cases pin down;
// the provider-set cases live in fulfillment-pricing.e2e-spec.ts.
// Express left the delivery leg — it is a turnaround tier now (see
// fulfillment-pricing.e2e-spec.ts). These cases now use the paid
// SCHEDULED_PAID return tier, which is what they were really about:
// a non-free return leg priced identically at quote and at create.
const RETURN_FEE_SCHEDULED_PAID = 5_000; // ₱50
const PICKUP_FEE_SCHEDULED_PAID = 5_000; // ₱50
const DEFAULT_FEE_PERCENT = 10;
// scheduledPickup became a REQUIRED field on CreateOrderInput when booking
// availability landed, but this spec was never updated — every order-creating
// case here has been failing on "Field \"scheduledPickup\" ... was not provided"
// since. A plain near-future date is enough: only `date` is non-null on
// ScheduledPickupInput, and this suite is about money, not slot capacity.
const PICKUP_DATE = new Date(Date.now() + 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const SCHEDULED_PICKUP = { date: PICKUP_DATE };
const ACTIVATION_MIN = 100_000; // ₱1,000

const QUOTE = /* GraphQL */ `
  query Quote($input: QuoteOrderInput!) {
    quoteOnlineOrder(input: $input) {
      serviceSubtotalCentavos
      platformFeePercent
      platformFeeCentavos
      pickupFeeCentavos
      returnFeeCentavos
      customerTotalCentavos
      estimatedTotalCentavos
      pricingRuleVersion
    }
  }
`;

const CREATE = /* GraphQL */ `
  mutation Create($input: CreateOnlineOrderInput!) {
    createOnlineOrder(input: $input) {
      _id
      status
      paymentStatus
      paymentTiming
      pricing {
        serviceSubtotalCentavos
        platformFeePercent
        platformFeeCentavos
        pickupFeeCentavos
        returnFeeCentavos
        estimatedTotalCentavos
        customerTotalCentavos
      }
    }
  }
`;

const ACCEPT = /* GraphQL */ `
  mutation Accept($orderId: ID!) {
    acceptOnlineOrder(orderId: $orderId) {
      _id
      status
    }
  }
`;

const RECEIVE = /* GraphQL */ `
  mutation Receive($orderId: ID!, $input: RecordCollectionInput!) {
    receiveOrderAtCounter(orderId: $orderId, input: $input) {
      _id
      status
      paymentStatus
      pricing {
        actualWeightKg
        actualServiceTotalCentavos
        platformFeeCentavos
        pickupFeeCentavos
        returnFeeCentavos
        customerTotalCentavos
      }
      paymentSummary {
        method
        amountCollectedCentavos
        tenderedCentavos
        changeCentavos
      }
    }
  }
`;

describe('Money integrity (e2e)', () => {
  let ctx: E2EContext;
  let server: any;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // Part 1 — quote -> create -> collect centavo equality
  // ===========================================================================
  describe('quote -> create -> collect', () => {
    let customerUid: string;
    let addressId: string;
    let branchId: string;
    let ownerUid: string;
    let serviceId: string;

    // ₱60.00/kg
    const PRICE_PER_KG = 6_000;

    beforeAll(async () => {
      customerUid = await seedUser(ctx.connection, 'customer');
      addressId = await seedAddress(ctx.connection, customerUid);
      const b = await seedMerchantBranch(ctx.connection);
      branchId = b.branchId;
      ownerUid = b.ownerUid;
      serviceId = await seedService(ctx.connection, branchId, ownerUid, {
        price: PRICE_PER_KG,
        pricingType: 'per_kilo',
      });
      await seedWallet(ctx.connection, branchId, 500_000, true);
    });

    it('quotes subtotal + 10% platform fee + return fee with exact centavo arithmetic', async () => {
      const estimatedKg = 5.5;
      const data = await gqlOk(
        server,
        QUOTE,
        {
          input: {
            branchId,
            providerType: 'MERCHANT',
            serviceLines: [
              { serviceRefId: serviceId, estimatedWeightKg: estimatedKg },
            ],
            pickupMode: 'CUSTOMER_DROPOFF',
            returnMode: 'PROVIDER_DELIVERY',
            deliverySubMode: 'SCHEDULED_PAID',
          },
        },
        customerUid,
      );
      const p = data.quoteOnlineOrder;

      const subtotal = Math.round(estimatedKg * PRICE_PER_KG); // 33000
      const fee = Math.round((subtotal * DEFAULT_FEE_PERCENT) / 100); // 3300
      expect(p.serviceSubtotalCentavos).toBe(subtotal);
      expect(p.platformFeePercent).toBe(DEFAULT_FEE_PERCENT);
      expect(p.platformFeeCentavos).toBe(fee);
      expect(p.pickupFeeCentavos).toBe(0); // customer drops off => free
      expect(p.returnFeeCentavos).toBe(RETURN_FEE_SCHEDULED_PAID);
      expect(p.customerTotalCentavos).toBe(
        subtotal + fee + 0 + RETURN_FEE_SCHEDULED_PAID,
      );
      // The two total fields must never disagree.
      expect(p.estimatedTotalCentavos).toBe(p.customerTotalCentavos);
      expect(p.pricingRuleVersion).toBe('fulfillment-fees-v2');
    });

    it('charges the scheduled-paid pickup fee and the scheduled-paid return fee together', async () => {
      const data = await gqlOk(
        server,
        QUOTE,
        {
          input: {
            branchId,
            providerType: 'MERCHANT',
            serviceLines: [{ serviceRefId: serviceId, estimatedWeightKg: 2 }],
            pickupMode: 'PROVIDER_PICKUP',
            pickupSubMode: 'SCHEDULED_PAID',
            returnMode: 'PROVIDER_DELIVERY',
            deliverySubMode: 'SCHEDULED_PAID',
          },
        },
        customerUid,
      );
      const p = data.quoteOnlineOrder;
      const subtotal = 2 * PRICE_PER_KG;
      const fee = Math.round((subtotal * DEFAULT_FEE_PERCENT) / 100);
      expect(p.pickupFeeCentavos).toBe(PICKUP_FEE_SCHEDULED_PAID);
      expect(p.returnFeeCentavos).toBe(RETURN_FEE_SCHEDULED_PAID);
      expect(p.customerTotalCentavos).toBe(
        subtotal + fee + PICKUP_FEE_SCHEDULED_PAID + RETURN_FEE_SCHEDULED_PAID,
      );
    });

    it('free-batch pickup and free-batch return are genuinely ₱0', async () => {
      const data = await gqlOk(
        server,
        QUOTE,
        {
          input: {
            branchId,
            providerType: 'MERCHANT',
            serviceLines: [{ serviceRefId: serviceId, estimatedWeightKg: 1 }],
            pickupMode: 'PROVIDER_PICKUP',
            pickupSubMode: 'FREE_BATCH',
            returnMode: 'PROVIDER_DELIVERY',
            deliverySubMode: 'FREE_BATCH',
          },
        },
        customerUid,
      );
      expect(data.quoteOnlineOrder.pickupFeeCentavos).toBe(0);
      expect(data.quoteOnlineOrder.returnFeeCentavos).toBe(0);
    });

    it('rejects EXPRESS as a pickup tier (it is a return-only option)', async () => {
      const res = await gql(
        server,
        QUOTE,
        {
          input: {
            branchId,
            providerType: 'MERCHANT',
            serviceLines: [{ serviceRefId: serviceId, estimatedWeightKg: 1 }],
            pickupMode: 'PROVIDER_PICKUP',
            pickupSubMode: 'EXPRESS',
          },
        },
        customerUid,
      );
      expect(firstErrorMessage(res)).toMatch(
        /Express is not a valid pickup option/i,
      );
    });

    it('carries the quoted numbers, unchanged, onto the created order snapshot', async () => {
      const estimatedKg = 5.5;
      const quoteInput = {
        branchId,
        providerType: 'MERCHANT',
        serviceLines: [
          { serviceRefId: serviceId, estimatedWeightKg: estimatedKg },
        ],
        pickupMode: 'CUSTOMER_DROPOFF',
        returnMode: 'PROVIDER_DELIVERY',
        deliverySubMode: 'SCHEDULED_PAID',
      };
      const quoted = (
        await gqlOk(server, QUOTE, { input: quoteInput }, customerUid)
      ).quoteOnlineOrder;

      const created = (
        await gqlOk(
          server,
          CREATE,
          {
            input: {
              ...quoteInput,
              addressId,
              scheduledPickup: SCHEDULED_PICKUP,
            },
          },
          customerUid,
        )
      ).createOnlineOrder;

      expect(created.pricing.serviceSubtotalCentavos).toBe(
        quoted.serviceSubtotalCentavos,
      );
      expect(created.pricing.platformFeeCentavos).toBe(
        quoted.platformFeeCentavos,
      );
      expect(created.pricing.pickupFeeCentavos).toBe(quoted.pickupFeeCentavos);
      expect(created.pricing.returnFeeCentavos).toBe(quoted.returnFeeCentavos);
      expect(created.pricing.estimatedTotalCentavos).toBe(
        quoted.estimatedTotalCentavos,
      );
      // Nothing is collected at create.
      expect(created.pricing.customerTotalCentavos).toBeNull();
      expect(created.paymentStatus).toBe('UNPAID');
      expect(created.paymentTiming).toBe('ON_PICKUP');
      expect(created.status).toBe('PENDING_PROVIDER_ACCEPTANCE');
    });

    it('collects exactly the server-computed total on the actual weight, fees included', async () => {
      const estimatedKg = 5;
      const actualKg = 7.25; // customer under-estimated
      const input = {
        branchId,
        providerType: 'MERCHANT',
        addressId,
        serviceLines: [
          { serviceRefId: serviceId, estimatedWeightKg: estimatedKg },
        ],
        pickupMode: 'CUSTOMER_DROPOFF',
        returnMode: 'PROVIDER_DELIVERY',
        deliverySubMode: 'SCHEDULED_PAID',
        scheduledPickup: SCHEDULED_PICKUP,
      };
      const order = (await gqlOk(server, CREATE, { input }, customerUid))
        .createOnlineOrder;

      await gqlOk(server, ACCEPT, { orderId: order._id }, ownerUid);

      const expectedService = Math.round(actualKg * PRICE_PER_KG); // 43500
      const expectedFee = Math.round(
        (expectedService * DEFAULT_FEE_PERCENT) / 100,
      ); // 4350
      const expectedTotal =
        expectedService + expectedFee + 0 + RETURN_FEE_SCHEDULED_PAID;

      const received = (
        await gqlOk(
          server,
          RECEIVE,
          {
            orderId: order._id,
            input: {
              actualWeightKg: actualKg,
              paymentMethod: 'CASH',
              tenderedCentavos: expectedTotal + 10_000,
            },
          },
          ownerUid,
        )
      ).receiveOrderAtCounter;

      expect(received.pricing.actualWeightKg).toBe(actualKg);
      expect(received.pricing.actualServiceTotalCentavos).toBe(expectedService);
      expect(received.pricing.platformFeeCentavos).toBe(expectedFee);
      expect(received.pricing.returnFeeCentavos).toBe(
        RETURN_FEE_SCHEDULED_PAID,
      );
      expect(received.pricing.customerTotalCentavos).toBe(expectedTotal);

      // The amount RECORDED as collected must equal the amount COMPUTED —
      // never anything the client supplied.
      expect(received.paymentSummary.amountCollectedCentavos).toBe(
        expectedTotal,
      );
      expect(received.paymentSummary.changeCentavos).toBe(10_000);
      expect(received.paymentStatus).toBe('PAID');
    });

    it('refuses cash tendered below the amount due', async () => {
      const input = {
        branchId,
        providerType: 'MERCHANT',
        addressId,
        serviceLines: [{ serviceRefId: serviceId, estimatedWeightKg: 3 }],
        pickupMode: 'CUSTOMER_DROPOFF',
        returnMode: 'CUSTOMER_SELF_PICKUP',
        scheduledPickup: SCHEDULED_PICKUP,
      };
      const order = (await gqlOk(server, CREATE, { input }, customerUid))
        .createOnlineOrder;
      await gqlOk(server, ACCEPT, { orderId: order._id }, ownerUid);

      const res = await gql(
        server,
        RECEIVE,
        {
          orderId: order._id,
          input: {
            actualWeightKg: 3,
            paymentMethod: 'CASH',
            tenderedCentavos: 1,
          },
        },
        ownerUid,
      );
      expect(firstErrorMessage(res)).toMatch(/Tendered cash is less than/i);
    });

    it('debits the provider wallet by exactly the platform fee on collection', async () => {
      const startBalance = 500_000;
      const b = await seedMerchantBranch(ctx.connection);
      const svc = await seedService(ctx.connection, b.branchId, b.ownerUid, {
        price: PRICE_PER_KG,
      });
      await seedWallet(ctx.connection, b.branchId, startBalance, true);

      const order = (
        await gqlOk(
          server,
          CREATE,
          {
            input: {
              branchId: b.branchId,
              providerType: 'MERCHANT',
              addressId,
              serviceLines: [{ serviceRefId: svc, estimatedWeightKg: 4 }],
              pickupMode: 'CUSTOMER_DROPOFF',
              scheduledPickup: SCHEDULED_PICKUP,
              returnMode: 'CUSTOMER_SELF_PICKUP',
            },
          },
          customerUid,
        )
      ).createOnlineOrder;
      await gqlOk(server, ACCEPT, { orderId: order._id }, b.ownerUid);

      const received = (
        await gqlOk(
          server,
          RECEIVE,
          {
            orderId: order._id,
            input: { actualWeightKg: 4, paymentMethod: 'CASH' },
          },
          b.ownerUid,
        )
      ).receiveOrderAtCounter;

      const fee = received.pricing.platformFeeCentavos;
      expect(fee).toBe(
        Math.round((4 * PRICE_PER_KG * DEFAULT_FEE_PERCENT) / 100),
      );

      const wallet = await ctx.connection
        .collection('wallets')
        .findOne({ branchId: b.branchId });
      expect(wallet!.balanceCentavos).toBe(startBalance - fee);

      const ledger = await ctx.connection
        .collection('wallet_ledger_entries')
        .find({ branchId: b.branchId })
        .toArray();
      const feeRows = ledger.filter((r) => r.orderId === order._id);
      expect(feeRows).toHaveLength(1);
      expect(feeRows[0].amountCentavos).toBe(-fee);
    });

    it('refuses to create an order against another customer’s address', async () => {
      const otherUid = await seedUser(ctx.connection, 'customer');
      const res = await gql(
        server,
        CREATE,
        {
          input: {
            branchId,
            providerType: 'MERCHANT',
            addressId, // belongs to customerUid
            serviceLines: [{ serviceRefId: serviceId, estimatedWeightKg: 1 }],
            pickupMode: 'CUSTOMER_DROPOFF',
            returnMode: 'CUSTOMER_SELF_PICKUP',
          },
        },
        otherUid,
      );
      expect(res.errors).toBeDefined();
    });
  });

  // ===========================================================================
  // Part 2 — webhook credit integrity
  // ===========================================================================
  describe('Xendit webhook credit integrity', () => {
    const post = (body: any, token = VALID_TOKEN) =>
      request(server)
        .post(WEBHOOK_PATH)
        .set('x-callback-token', token)
        .send(body);

    /** PENDING intent + its wallet, as initializeTopUp would leave them. */
    const seedIntent = async (amountCentavos: number, startBalance = 0) => {
      const b = await seedMerchantBranch(ctx.connection);
      await seedWallet(ctx.connection, b.branchId, startBalance, false);
      const _id = new Types.ObjectId();
      await ctx.connection.collection('topup_intents').insertOne({
        _id,
        branchId: b.branchId,
        amountCentavos,
        status: 'PENDING',
        xenditInvoiceId: null,
        invoiceUrl: null,
        resolvedAt: null,
        createdAt: new Date(),
      });
      return { branchId: b.branchId, intentId: String(_id) };
    };

    const walletOf = (branchId: string) =>
      ctx.connection.collection('wallets').findOne({ branchId });

    const creditRows = (branchId: string) =>
      ctx.connection
        .collection('wallet_ledger_entries')
        .find({ branchId, xenditReference: { $type: 'string' } })
        .toArray();

    it('credits a verified PAID callback exactly once', async () => {
      const { branchId, intentId } = await seedIntent(50_000);
      const res = await post({
        id: 'inv_ok_1',
        external_id: intentId,
        status: 'PAID',
        amount: 500, // pesos -> 50,000 centavos
        currency: 'PHP',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, alreadyPosted: false });

      expect((await walletOf(branchId))!.balanceCentavos).toBe(50_000);
      expect(await creditRows(branchId)).toHaveLength(1);
    });

    it('a DUPLICATE delivery of the same callback credits nothing further', async () => {
      const { branchId, intentId } = await seedIntent(50_000);
      const body = {
        id: 'inv_dup',
        external_id: intentId,
        status: 'PAID',
        amount: 500,
        currency: 'PHP',
      };

      const first = await post(body);
      expect(first.status).toBe(200);
      expect(first.body.alreadyPosted).toBe(false);

      const second = await post(body);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ok: true, alreadyPosted: true });

      const third = await post(body);
      expect(third.body.alreadyPosted).toBe(true);

      expect((await walletOf(branchId))!.balanceCentavos).toBe(50_000);
      expect(await creditRows(branchId)).toHaveLength(1);
    });

    it('CONCURRENT duplicate deliveries still credit exactly once', async () => {
      const { branchId, intentId } = await seedIntent(75_000);
      const body = {
        id: 'inv_race',
        external_id: intentId,
        status: 'PAID',
        amount: 750,
        currency: 'PHP',
      };
      const results = await Promise.all([post(body), post(body), post(body)]);
      for (const r of results) expect(r.status).toBe(200);
      expect(
        results.filter((r) => r.body.alreadyPosted === false),
      ).toHaveLength(1);

      expect((await walletOf(branchId))!.balanceCentavos).toBe(75_000);
      expect(await creditRows(branchId)).toHaveLength(1);
    });

    it('a FORGED external_id (no such intent) never credits anyone', async () => {
      const { branchId } = await seedIntent(50_000);
      const res = await post({
        id: 'inv_forged',
        external_id: String(new Types.ObjectId()),
        status: 'PAID',
        amount: 500,
        currency: 'PHP',
      });
      expect(res.status).toBe(404);
      expect((await walletOf(branchId))!.balanceCentavos).toBe(0);
      expect(await creditRows(branchId)).toHaveLength(0);
    });

    it('an INFLATED amount on a real intent is refused and credits nothing', async () => {
      const { branchId, intentId } = await seedIntent(50_000);
      const res = await post({
        id: 'inv_inflated',
        external_id: intentId,
        status: 'PAID',
        amount: 999_999, // ₱999,999 against a ₱500 intent
        currency: 'PHP',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not match the top-up intent/i);
      expect((await walletOf(branchId))!.balanceCentavos).toBe(0);
      expect(await creditRows(branchId)).toHaveLength(0);
    });

    it('a non-PHP currency is refused and credits nothing', async () => {
      const { branchId, intentId } = await seedIntent(50_000);
      const res = await post({
        id: 'inv_usd',
        external_id: intentId,
        status: 'PAID',
        amount: 500,
        currency: 'USD',
      });
      expect(res.status).toBe(400);
      expect((await walletOf(branchId))!.balanceCentavos).toBe(0);
    });

    it('an UNAUTHENTICATED callback for a real, valid intent credits nothing', async () => {
      const { branchId, intentId } = await seedIntent(50_000);
      const res = await request(server).post(WEBHOOK_PATH).send({
        id: 'inv_noauth',
        external_id: intentId,
        status: 'PAID',
        amount: 500,
        currency: 'PHP',
      });
      expect(res.status).toBe(401);
      expect((await walletOf(branchId))!.balanceCentavos).toBe(0);
      expect(await creditRows(branchId)).toHaveLength(0);
    });

    it('an EXPIRED callback resolves the intent without crediting, and a later PAID cannot revive it', async () => {
      const { branchId, intentId } = await seedIntent(50_000);
      const expired = await post({ external_id: intentId, status: 'EXPIRED' });
      expect(expired.status).toBe(200);
      expect((await walletOf(branchId))!.balanceCentavos).toBe(0);

      const late = await post({
        external_id: intentId,
        status: 'PAID',
        amount: 500,
        currency: 'PHP',
      });
      expect(late.status).toBe(400);
      expect((await walletOf(branchId))!.balanceCentavos).toBe(0);
    });

    it('stamps activatedAt only when the credit reaches the ₱1,000 onboarding floor', async () => {
      const below = await seedIntent(ACTIVATION_MIN - 1);
      await post({
        external_id: below.intentId,
        status: 'PAID',
        amount: (ACTIVATION_MIN - 1) / 100,
        currency: 'PHP',
      });
      const belowWallet = await walletOf(below.branchId);
      expect(belowWallet!.balanceCentavos).toBe(ACTIVATION_MIN - 1);
      expect(belowWallet!.activatedAt).toBeNull();

      const at = await seedIntent(ACTIVATION_MIN);
      await post({
        external_id: at.intentId,
        status: 'PAID',
        amount: ACTIVATION_MIN / 100,
        currency: 'PHP',
      });
      const atWallet = await walletOf(at.branchId);
      expect(atWallet!.balanceCentavos).toBe(ACTIVATION_MIN);
      expect(atWallet!.activatedAt).toBeTruthy();
    });

    it('converts whole-peso gateway amounts to integer centavos without drift', async () => {
      const { branchId, intentId } = await seedIntent(12_345);
      const res = await post({
        external_id: intentId,
        status: 'PAID',
        amount: 123.45,
        currency: 'PHP',
      });
      expect(res.status).toBe(200);
      const w = await walletOf(branchId);
      expect(w!.balanceCentavos).toBe(12_345);
      expect(Number.isInteger(w!.balanceCentavos)).toBe(true);
    });
  });
});
