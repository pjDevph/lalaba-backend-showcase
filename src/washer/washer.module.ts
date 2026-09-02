import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WasherService } from './washer.service';
import { WasherResolver } from './washer.resolver';
import { WasherCertificationResolver } from './washer-certification.resolver';
import { WasherAdminResolver } from './washer-admin.resolver';
import { StorageModule } from '../storage/storage.module';
import {
  WasherProfile,
  WasherProfileSchema,
} from './schemas/washer-profile.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import { Rating, RatingSchema } from '../ratings/schemas/rating.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { WasherServiceTemplatesModule } from '../washer-service-templates/washer-service-templates.module';
import { BookingPolicyModule } from '../booking-policy/booking-policy.module';

// GAP-P0-011: WasherBooking / WasherEarning models are intentionally NOT
// registered here anymore. The schema files stay on disk purely to document
// the shape of the preserved legacy collections (washer_bookings /
// washer_earnings) — nothing in Phase 2 runtime reads or writes them.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: Rating.name, schema: RatingSchema },
    ]),
    UsersModule,
    DevicesModule,
    WasherServiceTemplatesModule,
    StorageModule,
    BookingPolicyModule,
  ],
  providers: [
    WasherService,
    WasherResolver,
    WasherCertificationResolver,
    WasherAdminResolver,
  ],
  exports: [WasherService],
})
export class WasherModule {}
