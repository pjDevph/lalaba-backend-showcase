import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BookingAvailabilityService } from './booking-availability.service';
import { BookingAvailabilityResolver } from './booking-availability.resolver';
import {
  BookingAvailabilityConfig,
  BookingAvailabilityConfigSchema,
} from './schemas/booking-availability-config.schema';
import {
  BookingDateOverride,
  BookingDateOverrideSchema,
} from './schemas/booking-date-override.schema';
import {
  BookingBlackout,
  BookingBlackoutSchema,
} from './schemas/booking-blackout.schema';
import {
  BookingSlotCounter,
  BookingSlotCounterSchema,
} from './schemas/booking-slot-counter.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { BookingPolicyModule } from '../booking-policy/booking-policy.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: BookingAvailabilityConfig.name,
        schema: BookingAvailabilityConfigSchema,
      },
      { name: BookingDateOverride.name, schema: BookingDateOverrideSchema },
      { name: BookingBlackout.name, schema: BookingBlackoutSchema },
      { name: BookingSlotCounter.name, schema: BookingSlotCounterSchema },
      // Read-only here: booking counts are recomputed from the orders
      // collection rather than trusted to a cached counter.
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: Branch.name, schema: BranchSchema },
    ]),
    // Entitlements are computed from the platform policy, never copied
    // onto a provider — see BookingPolicy's header.
    BookingPolicyModule,
  ],
  providers: [BookingAvailabilityService, BookingAvailabilityResolver],
  // OnlineOrdersModule consumes the service to gate createOrder.
  exports: [BookingAvailabilityService],
})
export class BookingAvailabilityModule {}
