import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { PromotionsService } from './promotions.service';
import { PromoCode } from './schemas/promo-code.schema';
import { PromoRedemption } from './schemas/promo-redemption.schema';
import {
  CreatePromoInput,
  PromoFilterInput,
  RedeemPromoInput,
  UpdatePromoInput,
} from './dto/create-promo.input';
import {
  PaginatedPromoCodes,
  PromoUsageSummary,
  PromoValidation,
} from './models/promo.models';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../admin-audit/schemas/admin-audit-event.schema';

/**
 * Promo code management. Admin only — a discount is money the platform gives
 * up, which sits with whoever owns platform-wide rules rather than with
 * day-to-day support work.
 *
 * `validatePromoCode` and `redeemPromoCode` are the exceptions: they exist so
 * a future checkout integration (or a support agent applying a code by hand
 * on a call) has something to call, but nothing in the product calls them
 * automatically today — there is no live "enter a code at checkout" flow.
 * Wiring one in is customer-app and order-pricing work, out of scope here.
 */
@Resolver(() => PromoCode)
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class PromotionsResolver {
  constructor(
    private readonly promotions: PromotionsService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Query(() => PaginatedPromoCodes, { name: 'promoCodes' })
  async promoCodes(
    @Args('filter', { nullable: true }) filter?: PromoFilterInput,
  ): Promise<PaginatedPromoCodes> {
    return this.promotions.find(filter ?? {});
  }

  @Query(() => PromoCode, { name: 'promoCode' })
  async promoCode(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PromoCode> {
    return this.promotions.findOne(id);
  }

  @Query(() => PromoUsageSummary, { name: 'promoUsageSummary' })
  async promoUsageSummary(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PromoUsageSummary> {
    return this.promotions.usageSummary(id);
  }

  /** Support/engineering tool: check what a code would do before redeeming it. */
  @Query(() => PromoValidation, { name: 'validatePromoCode' })
  async validatePromoCode(
    @Args('code') code: string,
    @Args('customerUid', { type: () => ID }) customerUid: string,
    @Args('orderTotalCentavos') orderTotalCentavos: number,
  ): Promise<PromoValidation> {
    return this.promotions.validate(code, customerUid, orderTotalCentavos);
  }

  @Mutation(() => PromoCode)
  async createPromoCode(
    @Args('input') input: CreatePromoInput,
    @CurrentUser() actor: User,
  ): Promise<PromoCode> {
    const promo = await this.promotions.create(
      input,
      String(actor._id),
      `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || actor.email,
    );
    await this.adminAudit.record({
      action: AdminAuditAction.PROMO_CREATED,
      actor,
      targetType: AdminAuditTargetType.PROMO_CODE,
      targetId: String(promo._id),
      targetLabel: promo.code,
    });
    return promo;
  }

  @Mutation(() => PromoCode)
  async updatePromoCode(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePromoInput,
    @CurrentUser() actor: User,
  ): Promise<PromoCode> {
    const promo = await this.promotions.update(id, input);
    await this.adminAudit.record({
      action: AdminAuditAction.PROMO_UPDATED,
      actor,
      targetType: AdminAuditTargetType.PROMO_CODE,
      targetId: id,
      targetLabel: promo.code,
    });
    return promo;
  }

  @Mutation(() => PromoCode)
  async setPromoCodeActive(
    @Args('id', { type: () => ID }) id: string,
    @Args('isActive') isActive: boolean,
    @CurrentUser() actor: User,
  ): Promise<PromoCode> {
    const promo = await this.promotions.setActive(id, isActive);
    await this.adminAudit.record({
      action: isActive
        ? AdminAuditAction.PROMO_ACTIVATED
        : AdminAuditAction.PROMO_DEACTIVATED,
      actor,
      targetType: AdminAuditTargetType.PROMO_CODE,
      targetId: id,
      targetLabel: promo.code,
    });
    return promo;
  }

  /**
   * Records a redemption. `reason` is required because every call site today
   * is an admin acting on someone's behalf (a support goodwill gesture, a
   * manual correction) rather than a customer's own checkout — there is no
   * live checkout flow yet, so every redemption through this mutation is
   * itself an admin decision worth a reason on file.
   */
  @Mutation(() => PromoRedemption)
  async redeemPromoCode(
    @Args('input') input: RedeemPromoInput,
    @Args('reason') reason: string,
    @CurrentUser() actor: User,
  ): Promise<PromoRedemption> {
    const redemption = await this.promotions.redeem(input);
    await this.adminAudit.record({
      action: AdminAuditAction.PROMO_REDEEMED,
      actor,
      targetType: AdminAuditTargetType.PROMO_CODE,
      targetId: String(redemption.promoId),
      targetLabel: redemption.code,
      reasonCode: reason,
      details: {
        customerUid: input.customerUid,
        discountCentavos: redemption.discountAppliedCentavos,
      },
    });
    return redemption;
  }
}
