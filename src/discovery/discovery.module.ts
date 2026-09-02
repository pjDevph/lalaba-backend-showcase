import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DiscoveryService } from './discovery.service';
import { DiscoveryResolver } from './discovery.resolver';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import {
  WasherServiceTemplate,
  WasherServiceTemplateSchema,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { Rating, RatingSchema } from '../ratings/schemas/rating.schema';
import { Favorite, FavoriteSchema } from '../favorites/schemas/favorite.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import { WasherServiceOfferingsModule } from '../washer-service-offerings/washer-service-offerings.module';
import { PlatformFeeModule } from '../platform-fee/platform-fee.module';
import { BookingAvailabilityModule } from '../booking-availability/booking-availability.module';
import { BookingPolicyModule } from '../booking-policy/booking-policy.module';

@Module({
  imports: [
    // Pickup slots are the customer-facing view of booking availability.
    BookingAvailabilityModule,
    // entitlementFor() — the same policy computation isBookingAccepting()
    // needs, so the discovery badge agrees with the booking-availability
    // screen on whether a provider is actually accepting bookings.
    BookingPolicyModule,
    PlatformFeeModule,
    WasherServiceOfferingsModule,
    MongooseModule.forFeature([
      { name: Branch.name, schema: BranchSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: WasherServiceTemplate.name, schema: WasherServiceTemplateSchema },
      { name: Rating.name, schema: RatingSchema },
      { name: Favorite.name, schema: FavoriteSchema },
      { name: User.name, schema: UserSchema },
      { name: Wallet.name, schema: WalletSchema },
      // Read-only: today's order count behind a washer's daily-cap slot number.
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
    ]),
  ],
  providers: [DiscoveryService, DiscoveryResolver],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
