import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PosOrdersService } from './pos-orders.service';
import { PosOrdersResolver } from './pos-orders.resolver';
import { PosOrder, PosOrderSchema } from './schemas/pos-order.schema';
import {
  PosTransaction,
  PosTransactionSchema,
} from '../pos_transactions/schemas/pos-transaction.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Inventory,
  InventorySchema,
} from '../inventory/schemas/inventory.schema';
import {
  InventoryTransaction,
  InventoryTransactionSchema,
} from '../inventory/schemas/inventory-transaction.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TransactionsLoader } from './transactions.loader';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PosOrder.name, schema: PosOrderSchema },
      { name: PosTransaction.name, schema: PosTransactionSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Inventory.name, schema: InventorySchema },
      { name: InventoryTransaction.name, schema: InventoryTransactionSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Permission.name, schema: PermissionSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [
    PosOrdersService,
    PosOrdersResolver,
    PermissionsGuard,
    TransactionsLoader,
  ],
  exports: [PosOrdersService],
})
export class PosOrdersModule {}
