/**
 * SCHEDULED BOOKING, END TO END — the transaction path.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createOrder` only enters `session.withTransaction` + `assertSlotBookable`
 * when the input carries a `scheduledPickup`. No other spec in this repo ever
 * sends one, so that entire branch — the capacity read, the slot reservation,
 * and the counter `$inc` that share the create transaction — was never
 * executed by a test.
 *
 * It was also broken. `assertSlotBookable` loaded its four inputs through
 * `Promise.all` while passing the caller's `ClientSession` to each. A Mongo
 * session cannot run concurrent operations: the driver stamps them all with the
 * same txnNumber and a replica set rejects the second one with "Only servers in
 * a sharded cluster can start a new transaction at the active transaction
 * number". Every scheduled booking 500'd; only unscheduled ones (what the other
 * specs send) worked.
 *
 * This harness runs an in-memory REPLICA SET, so it reproduces that faithfully —
 * a standalone mongod would silently pass by never starting a transaction.
 */
import { createE2EApp, E2EContext } from './utils/e2e-app';
import { Types } from 'mongoose';
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

const SLOTS = /* GraphQL */ `
  query Slots($branchId: ID!, $providerType: ProviderType!, $date: String!) {
    providerBookingSlots(
      branchId: $branchId
      providerType: $providerType
      date: $date
    ) {
      startTime
      endTime
      isBookable
      remaining
    }
  }
`;

const CREATE_ORDER = /* GraphQL */ `
  mutation Create($input: CreateOnlineOrderInput!) {
    createOnlineOrder(input: $input) {
      _id
      status
      fulfillment {
        pickupMode
        returnMode
        scheduledPickup {
          date
          startTime
          endTime
        }
      }
    }
  }
`;

/** PH-local 'YYYY-MM-DD', `daysAhead` from today — clears same-day lead time. */
function phDate(daysAhead: number): string {
  const now = new Date();
  const ph = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8, no DST
  ph.setUTCDate(ph.getUTCDate() + daysAhead);
  return ph.toISOString().slice(0, 10);
}

describe('Scheduled booking (transaction path)', () => {
  let ctx: E2EContext;
  let server: unknown;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer();
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function seedBookableWasher() {
    const templateId = await seedWasherTemplate(ctx, 20_000);
    const { branchId } = await seedWasher(ctx.connection, {
      verificationStatus: 'APPROVED',
      offeredServiceTemplateIds: [templateId],
    });
    await seedWallet(ctx.connection, branchId, ACTIVATED_BALANCE, true);
    const customerUid = await seedUser(ctx.connection, 'customer');
    const addressId = await seedAddress(ctx.connection, customerUid);
    return { templateId, branchId, customerUid, addressId };
  }

  async function firstBookableSlot(
    branchId: string,
    date: string,
    asUid: string,
  ) {
    const res = await gqlOk<{
      providerBookingSlots: {
        startTime: string;
        endTime: string;
        isBookable: boolean;
      }[];
    }>(server, SLOTS, { branchId, providerType: 'WASHER', date }, asUid);
    return res.providerBookingSlots.find((s) => s.isBookable);
  }

  it('creates an order with a scheduled pickup window', async () => {
    const { templateId, branchId, customerUid, addressId } =
      await seedBookableWasher();
    const date = phDate(2);

    const slot = await firstBookableSlot(branchId, date, customerUid);
    expect(slot).toBeDefined();

    const res = await gql<{
      createOnlineOrder: {
        _id: string;
        fulfillment: {
          scheduledPickup: {
            date: string;
            startTime: string;
            endTime: string;
          } | null;
        };
      };
    }>(
      server,
      CREATE_ORDER,
      {
        input: {
          branchId,
          providerType: 'WASHER',
          addressId,
          serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
          pickupMode: 'PROVIDER_PICKUP',
          returnMode: 'PROVIDER_DELIVERY',
          scheduledPickup: {
            date,
            startTime: slot!.startTime,
            endTime: slot!.endTime,
          },
        },
      },
      customerUid,
    );

    // The regression: this used to fail with the sharded-cluster txnNumber error.
    expect(firstErrorMessage(res)).toBe('');

    const order = res.data!.createOnlineOrder;
    expect(order._id).toBeTruthy();
    expect(order.fulfillment.scheduledPickup).toMatchObject({
      date,
      startTime: slot!.startTime,
      endTime: slot!.endTime,
    });
  });

  it('reserves the slot, so the booked window is counted against capacity', async () => {
    const { templateId, branchId, customerUid, addressId } =
      await seedBookableWasher();
    const date = phDate(2);
    const slot = await firstBookableSlot(branchId, date, customerUid);
    expect(slot).toBeDefined();

    const before = await gqlOk<{
      providerBookingSlots: { startTime: string; remaining: number }[];
    }>(server, SLOTS, { branchId, providerType: 'WASHER', date }, customerUid);
    const remainingBefore = before.providerBookingSlots.find(
      (s) => s.startTime === slot!.startTime,
    )!.remaining;

    await gqlOk(
      server,
      CREATE_ORDER,
      {
        input: {
          branchId,
          providerType: 'WASHER',
          addressId,
          serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
          pickupMode: 'PROVIDER_PICKUP',
          returnMode: 'PROVIDER_DELIVERY',
          scheduledPickup: {
            date,
            startTime: slot!.startTime,
            endTime: slot!.endTime,
          },
        },
      },
      customerUid,
    );

    const after = await gqlOk<{
      providerBookingSlots: { startTime: string; remaining: number }[];
    }>(server, SLOTS, { branchId, providerType: 'WASHER', date }, customerUid);
    const remainingAfter = after.providerBookingSlots.find(
      (s) => s.startTime === slot!.startTime,
    )!.remaining;

    // The counter $inc runs inside the create transaction — if the transaction
    // had rolled back, the order would exist without consuming capacity.
    expect(remainingAfter).toBe(remainingBefore - 1);
  });

  it('rejects a window the provider does not offer', async () => {
    const { templateId, branchId, customerUid, addressId } =
      await seedBookableWasher();
    const date = phDate(2);

    const res = await gql(
      server,
      CREATE_ORDER,
      {
        input: {
          branchId,
          providerType: 'WASHER',
          addressId,
          serviceLines: [{ serviceRefId: templateId, estimatedWeightKg: 5 }],
          pickupMode: 'PROVIDER_PICKUP',
          returnMode: 'PROVIDER_DELIVERY',
          scheduledPickup: {
            date,
            startTime: '03:00', // outside the default 08:00–20:00 window
            endTime: '03:30',
          },
        },
      },
      customerUid,
    );

    // A real rejection, not the transaction crash: the message must name the
    // slot problem rather than surface a Mongo error.
    expect(firstErrorMessage(res)).toMatch(/booking slots|window|not offer/i);
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
