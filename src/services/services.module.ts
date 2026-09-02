import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServicesService } from './services.service';
import { ServicesResolver } from './services.resolver';
import { Service, ServiceSchema } from './schemas/service.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  Inventory,
  InventorySchema,
} from '../inventory/schemas/inventory.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import {
  PosOrder,
  PosOrderSchema,
} from '../pos_orders/schemas/pos-order.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Service.name, schema: ServiceSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Inventory.name, schema: InventorySchema },
      { name: Permission.name, schema: PermissionSchema },
      { name: PosOrder.name, schema: PosOrderSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [ServicesService, ServicesResolver, PermissionsGuard],
  exports: [ServicesService],
})
export class ServicesModule {}
