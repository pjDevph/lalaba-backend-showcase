import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BookingPolicyService } from './booking-policy.service';
import { BookingPolicyResolver } from './booking-policy.resolver';
import {
  BookingPolicy,
  BookingPolicySchema,
} from './schemas/booking-policy.schema';
import {
  BookingMilestone,
  BookingMilestoneSchema,
} from './schemas/booking-milestone.schema';
import {
  BookingCampaign,
  BookingCampaignSchema,
} from './schemas/booking-campaign.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BookingPolicy.name, schema: BookingPolicySchema },
      { name: BookingMilestone.name, schema: BookingMilestoneSchema },
      { name: BookingCampaign.name, schema: BookingCampaignSchema },
      // Read-only: milestone statistics are counted from real orders rather
      // than cached onto the provider, so a rule change re-evaluates instantly.
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: Branch.name, schema: BranchSchema },
    ]),
  ],
  providers: [BookingPolicyService, BookingPolicyResolver],
  // BookingAvailabilityModule consumes the entitlement as the ceiling on a
  // provider's own capacity.
  exports: [BookingPolicyService],
})
export class BookingPolicyModule {}
