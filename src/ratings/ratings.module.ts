import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RatingsService } from './ratings.service';
import { RatingsResolver } from './ratings.resolver';
import { Rating, RatingSchema } from './schemas/rating.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Rating.name, schema: RatingSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
    ]),
  ],
  providers: [RatingsService, RatingsResolver],
  exports: [RatingsService],
})
export class RatingsModule {}
