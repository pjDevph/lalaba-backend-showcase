import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from './schemas/online-order.schema';
import { OrderStatus } from './schemas/order-status.enum';
import { OnlineOrdersService } from './online-orders.service';

/**
 * Background worker for blocking quality holds that time out unanswered
 * (GAP-H-014). Sweeps every 5 minutes for LAUNDRY_QUALITY_HOLD orders whose
 * 24h response window has lapsed and resolves each to the safest default via
 * OnlineOrdersService.autoResolveExpiredQualityHold — which is idempotent, so
 * a sweep racing a last-second customer response (or another instance's sweep)
 * is harmless: whoever loses simply finds the hold already resolved.
 */
@Injectable()
export class QualityHoldSchedulerService {
  private readonly logger = new Logger(QualityHoldSchedulerService.name);

  constructor(
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    private readonly ordersService: OnlineOrdersService,
  ) {}

  @Interval('quality-hold-sweep', 5 * 60 * 1000)
  async sweepExpiredQualityHolds(): Promise<number> {
    const expired = await this.orderModel
      .find({
        status: OrderStatus.LAUNDRY_QUALITY_HOLD,
        'activeQualityHold.respondTimeoutAt': { $lte: new Date() },
        'activeQualityHold.resolvedAt': null,
      })
      .select('_id')
      .lean()
      .exec();

    let resolved = 0;
    for (const doc of expired) {
      try {
        await this.ordersService.autoResolveExpiredQualityHold(String(doc._id));
        resolved += 1;
      } catch (err) {
        // One bad order must not stall the sweep for the rest.
        this.logger.error(
          `Failed to auto-resolve expired quality hold on order ${String(doc._id)}: ${String(err)}`,
        );
      }
    }
    if (resolved > 0) {
      this.logger.log(`Auto-resolved ${resolved} expired quality hold(s)`);
    }
    return resolved;
  }
}
