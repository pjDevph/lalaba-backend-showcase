import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PlatformAnalyticsService } from './platform-analytics.service';
import { PlatformAnalyticsResolver } from './platform-analytics.resolver';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
    ]),
  ],
  providers: [PlatformAnalyticsService, PlatformAnalyticsResolver],
})
export class PlatformAnalyticsModule {}
