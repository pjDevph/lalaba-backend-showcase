import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { UserVoucherView } from './models/user-voucher.model';
import { RedemptionSubjectType } from './schemas/promo-redemption.schema';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

/**
 * "My Vouchers", for the person holding them.
 *
 * A separate resolver from PromotionsResolver because that one is
 * `@Roles('admin')` at class level — deliberately, so a mutation added there
 * is admin-only by default. This surface is the opposite: any authenticated
 * account, scoped to ITSELF. There is no subject argument, so one account
 * cannot read another's vouchers by naming them.
 */
@Resolver(() => UserVoucherView)
@UseGuards(GqlAuthGuard)
export class UserVouchersResolver {
  constructor(private readonly promotions: PromotionsService) {}

  /**
   * `orderTotalCentavos` turns this from "what do I hold" into "what can I use
   * on THIS order" — the checkout picker passes it, the My Vouchers screen
   * does not. It is a subtotal to price against, never an amount that is
   * trusted: the discount is recalculated server-side at checkout regardless
   * of anything previewed here.
   */
  @Query(() => [UserVoucherView], { name: 'myVouchers' })
  async myVouchers(
    @CurrentUser() user: User,
    @Args('orderTotalCentavos', { type: () => Int, nullable: true })
    orderTotalCentavos?: number,
  ): Promise<UserVoucherView[]> {
    return this.promotions.vouchersFor(
      user._id,
      RedemptionSubjectType.CUSTOMER,
      orderTotalCentavos,
    );
  }
}
