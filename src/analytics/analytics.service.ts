import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PosOrder,
  PosOrderDocument,
  PaymentStatus,
} from '../pos_orders/schemas/pos-order.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import {
  AnalyticsFilterInput,
  AnalyticsGranularity,
} from './dto/analytics-filter.input';
import {
  RevenueSummary,
  BranchRevenueSummary,
} from './models/revenue-summary.model';
import { RevenueDataPoint } from './models/revenue-over-time.model';
import {
  applyBranchScope,
  resolveTenantScope,
} from '../common/scoping/tenant-scope';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(PosOrder.name)
    private readonly orderModel: Model<PosOrderDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
  ) {}

  private getRole(user: User): Role {
    return user.role as unknown as Role;
  }

  getMerchantId(user: User): string {
    const role = this.getRole(user);
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  /**
   * Branches this caller may read, or `null` for an owner — who is not branch
   * restricted at all. SEC-016: the old signature returned `[]` for BOTH an
   * owner and a staff member with no assignment, and the query builders read
   * that as "no constraint", so an unassigned staff silently got merchant-wide
   * visibility. `null` vs `[]` is now the difference between the two.
   */
  getBranchIds(user: User, activeBranchId?: string | null): string[] | null {
    // SEC-016/M6 — delegates to the canonical resolver. `null` means an owner,
    // who is not branch restricted; `[]` means staff with no assignment, who
    // must see nothing. The two were indistinguishable before.
    return resolveTenantScope(user, activeBranchId).allowedBranchIds;
  }

  private buildBaseMatch(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: AnalyticsFilterInput,
    paymentStatus: PaymentStatus,
  ): Record<string, any> {
    const match: Record<string, any> = {
      uid,
      paymentStatus,
      createdAt: { $gte: filter.dateFrom, $lte: filter.dateTo },
    };

    applyBranchScope(
      match,
      { merchantId: uid, allowedBranchIds },
      filter.branchId,
    );

    return match;
  }

  async getRevenueSummary(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: AnalyticsFilterInput,
  ): Promise<RevenueSummary> {
    if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) {
      throw new BadRequestException('Start date must be before end date.');
    }
    if (filter.branchId) {
      // Scope to merchant's own data — the uid filter on the aggregation already
      // limits results, so we just need to ensure the branchId is a valid ObjectId
      // to prevent injection. An invalid format will simply return no results.
      if (!/^[a-f\d]{24}$/i.test(filter.branchId)) {
        throw new BadRequestException('Invalid branch selected.');
      }
    }
    const paidMatch = this.buildBaseMatch(
      uid,
      allowedBranchIds,
      filter,
      PaymentStatus.PAID,
    );
    const refundedMatch = this.buildBaseMatch(
      uid,
      allowedBranchIds,
      filter,
      PaymentStatus.REFUNDED,
    );

    const [paidResult, refundedResult] = await Promise.all([
      this.orderModel
        .aggregate([
          { $match: paidMatch },
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: '$totalAmount' },
              totalOrders: { $sum: 1 },
              avgOrderValue: { $avg: '$totalAmount' },
              totalDiscounts: { $sum: '$discount' },
            },
          },
        ])
        .exec(),
      this.orderModel
        .aggregate([
          { $match: refundedMatch },
          { $group: { _id: null, totalRefunded: { $sum: '$totalAmount' } } },
        ])
        .exec(),
    ]);

    const paid = paidResult[0];
    const refunded = refundedResult[0];

    return {
      totalRevenue: paid?.totalRevenue ?? 0,
      totalOrders: paid?.totalOrders ?? 0,
      avgOrderValue: paid?.avgOrderValue ?? 0,
      totalDiscounts: paid?.totalDiscounts ?? 0,
      totalRefunded: refunded?.totalRefunded ?? 0,
    };
  }

  async getRevenueSummaryByBranch(
    uid: string,
    filter: AnalyticsFilterInput,
  ): Promise<BranchRevenueSummary[]> {
    if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) {
      throw new BadRequestException('Start date must be before end date.');
    }
    if (filter.branchId) {
      // Scope to merchant's own data — the uid filter on the aggregation already
      // limits results, so we just need to ensure the branchId is a valid ObjectId
      // to prevent injection. An invalid format will simply return no results.
      if (!/^[a-f\d]{24}$/i.test(filter.branchId)) {
        throw new BadRequestException('Invalid branch selected.');
      }
    }
    const match: Record<string, any> = {
      uid,
      paymentStatus: PaymentStatus.PAID,
      createdAt: { $gte: filter.dateFrom, $lte: filter.dateTo },
    };

    const results = await this.orderModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: '$branchId',
            totalRevenue: { $sum: '$totalAmount' },
            totalOrders: { $sum: 1 },
            avgOrderValue: { $avg: '$totalAmount' },
          },
        },
        {
          $lookup: {
            from: 'branches',
            localField: '_id',
            foreignField: '_id',
            as: 'branch',
          },
        },
        { $unwind: { path: '$branch', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            branchId: '$_id',
            branchName: { $ifNull: ['$branch.branchName', 'Unknown Branch'] },
            totalRevenue: 1,
            totalOrders: 1,
            avgOrderValue: 1,
            _id: 0,
          },
        },
        { $sort: { totalRevenue: -1 } },
      ])
      .exec();

    return results;
  }

  async getRevenueOverTime(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: AnalyticsFilterInput,
  ): Promise<RevenueDataPoint[]> {
    if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) {
      throw new BadRequestException('Start date must be before end date.');
    }
    if (filter.branchId) {
      // Scope to merchant's own data — the uid filter on the aggregation already
      // limits results, so we just need to ensure the branchId is a valid ObjectId
      // to prevent injection. An invalid format will simply return no results.
      if (!/^[a-f\d]{24}$/i.test(filter.branchId)) {
        throw new BadRequestException('Invalid branch selected.');
      }
    }
    const match = this.buildBaseMatch(
      uid,
      allowedBranchIds,
      filter,
      PaymentStatus.PAID,
    );

    const granularity = filter.granularity ?? AnalyticsGranularity.DAY;
    const formatMap: Record<AnalyticsGranularity, string> = {
      [AnalyticsGranularity.DAY]: '%Y-%m-%d',
      [AnalyticsGranularity.WEEK]: '%G-W%V',
      [AnalyticsGranularity.MONTH]: '%Y-%m',
    };
    const format = formatMap[granularity];

    const results = await this.orderModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $dateToString: { format, date: '$createdAt', timezone: '+08:00' },
            },
            totalRevenue: { $sum: '$totalAmount' },
            orderCount: { $sum: 1 },
            avgOrderValue: { $avg: '$totalAmount' },
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            period: '$_id',
            totalRevenue: 1,
            orderCount: 1,
            avgOrderValue: 1,
            _id: 0,
          },
        },
      ])
      .exec();

    return results;
  }
}
