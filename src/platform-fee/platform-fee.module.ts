import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PlatformFeeService } from './platform-fee.service';
import { PlatformFeeResolver } from './platform-fee.resolver';
import {
  PlatformFeeConfig,
  PlatformFeeConfigSchema,
} from './schemas/platform-fee-config.schema';
import {
  PlatformFeeRule,
  PlatformFeeRuleSchema,
} from './schemas/platform-fee-rule.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PlatformFeeRule.name, schema: PlatformFeeRuleSchema },
      // The pre-rules global config. Still registered because the rules
      // resolver falls back to it on any environment whose database has not
      // been seeded yet, and because its history stays readable.
      { name: PlatformFeeConfig.name, schema: PlatformFeeConfigSchema },
      // Read-only here — the admin dashboard's "today's platform revenue"
      // figure is summed from completed orders, not tracked as its own ledger.
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
    ]),
  ],
  providers: [PlatformFeeService, PlatformFeeResolver],
  exports: [PlatformFeeService],
})
export class PlatformFeeModule {}
