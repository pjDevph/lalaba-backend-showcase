import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InventoryService } from './inventory.service';
import { InventoryResolver } from './inventory.resolver';
import { Inventory, InventorySchema } from './schemas/inventory.schema';
import {
  InventoryTransaction,
  InventoryTransactionSchema,
} from './schemas/inventory-transaction.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Inventory.name, schema: InventorySchema },
      { name: InventoryTransaction.name, schema: InventoryTransactionSchema },
      { name: Permission.name, schema: PermissionSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Service.name, schema: ServiceSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [InventoryService, InventoryResolver, PermissionsGuard],
  exports: [InventoryService],
})
export class InventoryModule {}
