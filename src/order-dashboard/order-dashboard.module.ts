import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrderDashboardService } from './order-dashboard.service';
import { OrderDashboardResolver } from './order-dashboard.resolver';
import {
  PosOrder,
  PosOrderSchema,
} from '../pos_orders/schemas/pos-order.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PosOrder.name, schema: PosOrderSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: Branch.name, schema: BranchSchema },
    ]),
  ],
  providers: [OrderDashboardService, OrderDashboardResolver],
})
export class OrderDashboardModule {}
