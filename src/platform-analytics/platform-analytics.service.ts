import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import { OrderStatus } from '../online-orders/schemas/order-status.enum';
import { PlatformAnalyticsRangeInput } from './dto/platform-analytics-range.input';
import { PlatformOverview } from './models/platform-overview.model';

const PH_TZ = '+08:00';

// Statuses that mean the order never converted to revenue. Rejection is
// counted alongside cancellation on purpose — from a platform-health
// perspective "a provider refused it" and "the customer backed out" are the
// same signal (demand that did not turn into a completed order); ratings and
// support already break the two apart when the distinction matters.
const NON_CONVERTING_STATUSES = [
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED_BY_PROVIDER,
];

const ORDER_TOTAL_EXPR = {
  $ifNull: [
    '$pricing.customerTotalCentavos',
    '$pricing.estimatedTotalCentavos',
  ],
};

/**
 * The GMV / throughput / revenue view the admin dashboard's own comment flags
 * as missing ("things that would need a new aggregation layer... intentionally
 * left off"). Platform-wide, across every provider — NOT the merchant-facing
 * `analytics` module (POS orders, scoped to one merchant's own branches).
 * Different audience, different collection, different math; sharing a module
 * would have meant threading an admin-vs-merchant branch through every method.
 *
 * One aggregation pipeline per range, run fresh on every call — there is no
 * rollup table. Order volume across the platform's lifetime is nowhere near
 * the point where that would matter, and a rollup is a second source of truth
 * to keep in sync with the ledger of record (online_orders) for no benefit at
 * today's scale.
 */
@Injectable()
export class PlatformAnalyticsService {
  constructor(
    @InjectModel(OnlineOrder.name)
    private readonly onlineOrderModel: Model<OnlineOrderDocument>,
  ) {}

  async overview(
    range: PlatformAnalyticsRangeInput,
  ): Promise<PlatformOverview> {
    const from = range.from ?? new Date(0);
    const to = range.to ?? new Date();

    const [createdAgg] = await this.onlineOrderModel
      .aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            ordersCreated: { $sum: 1 },
            ordersCancelled: {
              $sum: {
                $cond: [{ $in: ['$status', NON_CONVERTING_STATUSES] }, 1, 0],
              },
            },
          },
        },
      ])
      .exec();

    const completedMatch = {
      status: OrderStatus.COMPLETED,
      completedAt: { $gte: from, $lte: to },
    };

    const [completedAgg] = await this.onlineOrderModel
      .aggregate([
        { $match: completedMatch },
        { $addFields: { orderTotal: ORDER_TOTAL_EXPR } },
        {
          $group: {
            _id: null,
            ordersCompleted: { $sum: 1 },
            gmvCentavos: { $sum: '$orderTotal' },
            platformFeeRevenueCentavos: {
              $sum: '$pricing.platformFeeCentavos',
            },
            activeCustomers: { $addToSet: '$customer.uid' },
            activeProviders: { $addToSet: '$provider.branchId' },
          },
        },
      ])
      .exec();

    const daily = await this.onlineOrderModel
      .aggregate([
        { $match: completedMatch },
        {
          $addFields: {
            orderTotal: ORDER_TOTAL_EXPR,
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$completedAt',
                timezone: PH_TZ,
              },
            },
          },
        },
        {
          $group: {
            _id: '$day',
            orders: { $sum: 1 },
            gmvCentavos: { $sum: '$orderTotal' },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();

    const byProviderType = await this.onlineOrderModel
      .aggregate([
        { $match: completedMatch },
        { $addFields: { orderTotal: ORDER_TOTAL_EXPR } },
        {
          $group: {
            _id: '$provider.providerType',
            orders: { $sum: 1 },
            gmvCentavos: { $sum: '$orderTotal' },
          },
        },
      ])
      .exec();

    const topProviders = await this.onlineOrderModel
      .aggregate([
        { $match: completedMatch },
        { $addFields: { orderTotal: ORDER_TOTAL_EXPR } },
        {
          $group: {
            _id: '$provider.branchId',
            providerName: { $last: '$provider.providerName' },
            providerType: { $last: '$provider.providerType' },
            orders: { $sum: 1 },
            gmvCentavos: { $sum: '$orderTotal' },
          },
        },
        { $sort: { gmvCentavos: -1 } },
        { $limit: 10 },
      ])
      .exec();

    const ordersCreated = createdAgg?.ordersCreated ?? 0;
    const ordersCancelled = createdAgg?.ordersCancelled ?? 0;
    const ordersCompleted = completedAgg?.ordersCompleted ?? 0;
    const gmvCentavos = Math.round(completedAgg?.gmvCentavos ?? 0);

    return {
      ordersCreated,
      ordersCompleted,
      ordersCancelled,
      cancellationRate: ordersCreated > 0 ? ordersCancelled / ordersCreated : 0,
      gmvCentavos,
      platformFeeRevenueCentavos: Math.round(
        completedAgg?.platformFeeRevenueCentavos ?? 0,
      ),
      averageOrderValueCentavos:
        ordersCompleted > 0 ? Math.round(gmvCentavos / ordersCompleted) : 0,
      activeCustomers: (completedAgg?.activeCustomers ?? []).length,
      activeProviders: (completedAgg?.activeProviders ?? []).length,
      daily: daily.map((d) => ({
        date: d._id,
        orders: d.orders,
        gmvCentavos: Math.round(d.gmvCentavos ?? 0),
      })),
      byProviderType: byProviderType.map((p) => ({
        providerType: p._id,
        orders: p.orders,
        gmvCentavos: Math.round(p.gmvCentavos ?? 0),
      })),
      topProviders: topProviders.map((p) => ({
        branchId: p._id,
        providerName: p.providerName,
        providerType: p.providerType,
        orders: p.orders,
        gmvCentavos: Math.round(p.gmvCentavos ?? 0),
      })),
    };
  }
}
