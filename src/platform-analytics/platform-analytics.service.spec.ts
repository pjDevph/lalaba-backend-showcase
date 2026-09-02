import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';

import { PlatformAnalyticsService } from './platform-analytics.service';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  ProviderType,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
} from '../online-orders/schemas/order-status.enum';

describe('PlatformAnalyticsService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: PlatformAnalyticsService;

  const makeOrder = async (
    overrides: {
      customerUid?: string;
      providerType?: ProviderType;
      branchId?: string;
      providerName?: string;
      status?: OrderStatus;
      customerTotalCentavos?: number;
      estimatedTotalCentavos?: number;
      platformFeeCentavos?: number;
      createdAt?: Date;
      completedAt?: Date | null;
    } = {},
  ) =>
    connection.models[OnlineOrder.name].create({
      customer: {
        uid: overrides.customerUid ?? 'cust-1',
        displayName: 'Someone',
      },
      provider: {
        providerType: overrides.providerType ?? ProviderType.MERCHANT,
        providerUid: new Types.ObjectId().toString(),
        branchId: overrides.branchId ?? new Types.ObjectId().toString(),
        providerName: overrides.providerName ?? 'Shop',
      },
      serviceLines: [],
      fulfillment: {
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
      },
      pricing: {
        estimatedTotalCentavos: overrides.estimatedTotalCentavos ?? 10_000,
        customerTotalCentavos: overrides.customerTotalCentavos,
        platformFeeCentavos: overrides.platformFeeCentavos ?? 1_000,
      },
      paymentSummary: {},
      status: overrides.status ?? OrderStatus.COMPLETED,
      createdAt: overrides.createdAt ?? new Date(),
      completedAt:
        overrides.completedAt === null
          ? undefined
          : (overrides.completedAt ?? new Date()),
    });

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
        ]),
      ],
      providers: [PlatformAnalyticsService],
    }).compile();

    service = module.get(PlatformAnalyticsService);
    connection = module.get(getConnectionToken());
  }, 60_000);

  afterEach(async () => {
    await connection.models[OnlineOrder.name].deleteMany({});
  });

  afterAll(async () => {
    await module.close();
    await replSet.stop();
  });

  it('counts orders created in range regardless of status', async () => {
    await makeOrder({ status: OrderStatus.COMPLETED });
    await makeOrder({ status: OrderStatus.CANCELLED, completedAt: null });
    await makeOrder({
      status: OrderStatus.LAUNDRY_IN_PROGRESS,
      completedAt: null,
    });

    const result = await service.overview({});
    expect(result.ordersCreated).toBe(3);
    expect(result.ordersCancelled).toBe(1);
    expect(result.cancellationRate).toBeCloseTo(1 / 3);
  });

  it('sums GMV and platform fee revenue only from completed orders', async () => {
    await makeOrder({
      status: OrderStatus.COMPLETED,
      customerTotalCentavos: 15_000,
      platformFeeCentavos: 1_500,
    });
    await makeOrder({
      status: OrderStatus.COMPLETED,
      customerTotalCentavos: 5_000,
      platformFeeCentavos: 500,
    });
    // Not completed — should not count toward GMV even though it has a price.
    await makeOrder({
      status: OrderStatus.LAUNDRY_IN_PROGRESS,
      estimatedTotalCentavos: 99_999,
      completedAt: null,
    });

    const result = await service.overview({});
    expect(result.ordersCompleted).toBe(2);
    expect(result.gmvCentavos).toBe(20_000);
    expect(result.platformFeeRevenueCentavos).toBe(2_000);
    expect(result.averageOrderValueCentavos).toBe(10_000);
  });

  it('falls back to estimatedTotalCentavos when customerTotalCentavos is absent', async () => {
    await makeOrder({
      status: OrderStatus.COMPLETED,
      customerTotalCentavos: undefined,
      estimatedTotalCentavos: 8_000,
    });

    const result = await service.overview({});
    expect(result.gmvCentavos).toBe(8_000);
  });

  it('counts distinct active customers and providers', async () => {
    await makeOrder({ customerUid: 'cust-a', branchId: 'branch-1' });
    await makeOrder({ customerUid: 'cust-a', branchId: 'branch-1' });
    await makeOrder({ customerUid: 'cust-b', branchId: 'branch-2' });

    const result = await service.overview({});
    expect(result.activeCustomers).toBe(2);
    expect(result.activeProviders).toBe(2);
  });

  it('breaks GMV down by provider type', async () => {
    await makeOrder({
      providerType: ProviderType.MERCHANT,
      customerTotalCentavos: 10_000,
    });
    await makeOrder({
      providerType: ProviderType.WASHER,
      customerTotalCentavos: 6_000,
    });

    const result = await service.overview({});
    const merchant = result.byProviderType.find(
      (p) => p.providerType === ProviderType.MERCHANT,
    );
    const washer = result.byProviderType.find(
      (p) => p.providerType === ProviderType.WASHER,
    );
    expect(merchant?.gmvCentavos).toBe(10_000);
    expect(washer?.gmvCentavos).toBe(6_000);
  });

  it('ranks top providers by GMV, highest first, capped at 10', async () => {
    for (let i = 0; i < 12; i++) {
      await makeOrder({
        branchId: `branch-${i}`,
        providerName: `Shop ${i}`,
        customerTotalCentavos: (i + 1) * 1_000,
      });
    }

    const result = await service.overview({});
    expect(result.topProviders).toHaveLength(10);
    expect(result.topProviders[0].gmvCentavos).toBe(12_000);
    expect(result.topProviders[0].providerName).toBe('Shop 11');
    expect(result.topProviders[9].gmvCentavos).toBe(3_000);
  });

  it('builds a daily series bucketed by completedAt in PH time', async () => {
    await makeOrder({
      customerTotalCentavos: 5_000,
      completedAt: new Date('2026-08-10T05:00:00.000Z'),
    });
    await makeOrder({
      customerTotalCentavos: 3_000,
      completedAt: new Date('2026-08-10T10:00:00.000Z'),
    });

    const result = await service.overview({});
    const day = result.daily.find((d) => d.date === '2026-08-10');
    expect(day?.orders).toBe(2);
    expect(day?.gmvCentavos).toBe(8_000);
  });

  it('excludes orders outside the requested range', async () => {
    await makeOrder({
      customerTotalCentavos: 5_000,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      completedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    await makeOrder({
      customerTotalCentavos: 7_000,
      createdAt: new Date('2026-08-15T00:00:00.000Z'),
      completedAt: new Date('2026-08-15T00:00:00.000Z'),
    });

    const result = await service.overview({
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-31T23:59:59.999Z'),
    });
    expect(result.ordersCreated).toBe(1);
    expect(result.gmvCentavos).toBe(7_000);
  });

  it('returns zeroed-out numbers, not errors, when nothing is in range', async () => {
    const result = await service.overview({});
    expect(result.ordersCreated).toBe(0);
    expect(result.ordersCompleted).toBe(0);
    expect(result.gmvCentavos).toBe(0);
    expect(result.cancellationRate).toBe(0);
    expect(result.averageOrderValueCentavos).toBe(0);
    expect(result.daily).toEqual([]);
    expect(result.topProviders).toEqual([]);
  });
});
