import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductsService } from './products.service';
import { ProductsResolver } from './products.resolver';
import { Product, ProductSchema } from './schemas/product.schema';
import {
  Inventory,
  InventorySchema,
} from '../inventory/schemas/inventory.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Inventory.name, schema: InventorySchema },
      { name: Permission.name, schema: PermissionSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [ProductsService, ProductsResolver, PermissionsGuard],
  exports: [ProductsService],
})
export class ProductsModule {}
