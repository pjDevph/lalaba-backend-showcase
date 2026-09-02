import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WasherServiceProductsService } from './washer-service-products.service';
import { WasherServiceProductsResolver } from './washer-service-products.resolver';
import {
  ServiceProductDefault,
  ServiceProductDefaultSchema,
} from './schemas/service-product-default.schema';
import {
  Inventory,
  InventorySchema,
} from '../inventory/schemas/inventory.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { WasherModule } from '../washer/washer.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ServiceProductDefault.name, schema: ServiceProductDefaultSchema },
      { name: Inventory.name, schema: InventorySchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    WasherModule,
  ],
  providers: [WasherServiceProductsService, WasherServiceProductsResolver],
  exports: [WasherServiceProductsService],
})
export class WasherServiceProductsModule {}
