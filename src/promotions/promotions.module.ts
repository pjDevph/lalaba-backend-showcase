import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PromotionsService } from './promotions.service';
import { PromotionsResolver } from './promotions.resolver';
import { UserVouchersResolver } from './user-vouchers.resolver';
import { PromoCode, PromoCodeSchema } from './schemas/promo-code.schema';
import {
  PromoRedemption,
  PromoRedemptionSchema,
} from './schemas/promo-redemption.schema';
import { UserVoucher, UserVoucherSchema } from './schemas/user-voucher.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PromoCode.name, schema: PromoCodeSchema },
      { name: PromoRedemption.name, schema: PromoRedemptionSchema },
      { name: UserVoucher.name, schema: UserVoucherSchema },
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      // Read-only: only used to check firstOrderOnly eligibility.
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
    ]),
  ],
  providers: [PromotionsService, PromotionsResolver, UserVouchersResolver],
  exports: [PromotionsService],
})
export class PromotionsModule {}
