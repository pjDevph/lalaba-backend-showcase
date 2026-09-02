import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PosOrder,
  PosOrderDocument,
} from '../pos_orders/schemas/pos-order.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { DashboardOrder, OrderSource } from './models/dashboard-order.model';
import { PaginatedDashboardOrders } from './models/paginated-dashboard-orders.model';
import { DashboardFilterInput } from './dto/dashboard-filter.input';

@Injectable()
export class OrderDashboardService {
  constructor(
    @InjectModel(PosOrder.name)
    private readonly posOrderModel: Model<PosOrderDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly onlineOrderModel: Model<OnlineOrderDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
  ) {}

  private async assertBranchAccess(
    branchId: string,
    actor: User,
    activeBranchId?: string | null,
  ): Promise<void> {
    const role = actor.role as unknown as Role;
    if (role?.roleId === 'staff') {
      // The branch this device is working, not merely one of the branches this
      // account is assigned to — matching how PermissionsGuard picks the grants
      // that authorized the request in the first place.
      if (activeBranchId) {
        if (String(activeBranchId) !== branchId) {
          throw new ForbiddenException('You do not have access to this branch');
        }
        return;
      }
      const owned = ((actor.branchIds as unknown as string[]) ?? []).map(
        String,
      );
      if (!owned.includes(branchId)) {
        throw new ForbiddenException('You do not have access to this branch');
      }
      return;
    }
    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch || branch.uid !== actor._id) {
      throw new ForbiddenException('You do not manage this branch');
    }
  }

  private fromPosOrder(order: PosOrder): DashboardOrder {
    return {
      id: String((order as any)._id),
      source: OrderSource.POS,
      branchId: order.branchId,
      customerName: order.customerName ?? undefined,
      statusLabel: order.laundryStatus,
      totalAmountCentavos: Math.round(order.totalAmount * 100),
      claimCode: order.claimCode,
      createdAt: order.createdAt!,
    };
  }

  private fromOnlineOrder(order: OnlineOrder): DashboardOrder {
    return {
      id: String((order as any)._id),
      source: OrderSource.ONLINE,
      branchId: order.provider.branchId,
      customerName: order.customer.displayName,
      statusLabel: order.status,
      totalAmountCentavos:
        order.pricing.customerTotalCentavos ??
        order.pricing.estimatedTotalCentavos,
      createdAt: order.createdAt!,
    };
  }

  // Merges two independently-sorted, independently-capped result sets rather
  // than a single cross-collection query — correct within the fetched window
  // (§dashboard: read-side aggregation, not a schema merge).
  async getDashboard(
    branchId: string,
    actor: User,
    filter: DashboardFilterInput = {},
    activeBranchId?: string | null,
  ): Promise<PaginatedDashboardOrders> {
    await this.assertBranchAccess(branchId, actor, activeBranchId);
    const { source, limit = 20, offset = 0 } = filter;
    const wantsPos = source !== OrderSource.ONLINE;
    const wantsOnline = source !== OrderSource.POS;
    const fetchCount = offset + limit;

    const [posOrders, posTotal, onlineOrders, onlineTotal] = await Promise.all([
      wantsPos
        ? this.posOrderModel
            .find({ branchId })
            .sort({ createdAt: -1 })
            .limit(fetchCount)
            .exec()
        : Promise.resolve([]),
      wantsPos ? this.posOrderModel.countDocuments({ branchId }).exec() : 0,
      wantsOnline
        ? this.onlineOrderModel
            .find({ 'provider.branchId': branchId })
            .sort({ createdAt: -1 })
            .limit(fetchCount)
            .exec()
        : Promise.resolve([]),
      wantsOnline
        ? this.onlineOrderModel
            .countDocuments({ 'provider.branchId': branchId })
            .exec()
        : 0,
    ]);

    const merged = [
      ...posOrders.map((o) => this.fromPosOrder(o)),
      ...onlineOrders.map((o) => this.fromOnlineOrder(o)),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      data: merged.slice(offset, offset + limit),
      total: posTotal + onlineTotal,
      limit,
      offset,
    };
  }
}
