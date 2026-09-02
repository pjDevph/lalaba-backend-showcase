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
 * Background worker for deferred-settlement orders that never settled (§14).
 *
 * An order that deferred payment can come to rest in two places while the
 * provider is still holding the finished laundry: waiting for a redelivery to
 * be picked, or waiting for a self-pickup that may never happen. Both stamp an
 * `abandonmentDeadlineAt`; this sweep is what eventually acts on it, moving the
 * order to ABANDONED_UNSETTLED and crediting the provider back the platform fee
 * they fronted.
 *
 * Hourly, not every few minutes: the window is measured in days, so a tighter
 * cadence would only add load. Mirrors QualityHoldSchedulerService — per-order
 * try/catch so one bad document cannot stall the rest, and an idempotent
 * service call so a sweep racing another instance is harmless.
 */
@Injectable()
export class AbandonmentSchedulerService {
  private readonly logger = new Logger(AbandonmentSchedulerService.name);

  constructor(
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    private readonly ordersService: OnlineOrdersService,
  ) {}

  @Interval('unsettled-abandonment-sweep', 60 * 60 * 1000)
  async sweepAbandonedOrders(): Promise<number> {
    const expired = await this.orderModel
      .find({
        status: {
          $in: [
            OrderStatus.AWAITING_REDELIVERY_SELECTION,
            OrderStatus.AWAITING_CUSTOMER_PICKUP,
          ],
        },
        abandonmentDeadlineAt: { $ne: null, $lte: new Date() },
      })
      .select('_id')
      .lean()
      .exec();

    let abandoned = 0;
    for (const doc of expired) {
      try {
        await this.ordersService.abandonUnsettledOrder(String(doc._id));
        abandoned += 1;
      } catch (err) {
        // One bad order must not stall the sweep for the rest.
        this.logger.error(
          `Failed to abandon unsettled order ${String(doc._id)}: ${String(err)}`,
        );
      }
    }
    if (abandoned > 0) {
      this.logger.log(`Abandoned ${abandoned} unsettled order(s)`);
    }
    return abandoned;
  }
}
