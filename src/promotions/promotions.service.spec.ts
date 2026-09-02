import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { PromotionsService, computeStatus } from './promotions.service';
import { CreatePromoInput } from './dto/create-promo.input';
import {
  UserVoucher,
  UserVoucherSchema,
  UserVoucherStatus,
} from './schemas/user-voucher.schema';
import {
  PromoCode,
  PromoCodeSchema,
  PromoDiscountType,
  PromoScope,
  scopeOf,
} from './schemas/promo-code.schema';
import {
  PromoRedemption,
  PromoRedemptionSchema,
  PromoRedemptionStatus,
  RedemptionSubjectType,
} from './schemas/promo-redemption.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  ProviderType,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
} from '../online-orders/schemas/order-status.enum';

describe('PromotionsService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: PromotionsService;

  const makeRole = async (roleId: string) =>
    (await connection.models[Role.name].findOne({ roleId }).exec()) ??
    (await connection.models[Role.name].create({
      roleId,
      roleName: roleId,
      description: `${roleId} role`,
    }));

  const makeCustomer = async (firstName = 'Cara') => {
    const role = await makeRole('customer');
    const uid = new Types.ObjectId().toString();
    await connection.models[User.name].create({
      _id: uid,
      firstName,
      lastName: 'Test',
      email: `${uid}@example.com`,
      phoneNumber: '09171234567',
      role: role._id,
    });
    return uid;
  };

  const makeOrder = async (customerUid: string) =>
    connection.models[OnlineOrder.name].create({
      customer: { uid: customerUid, displayName: 'Someone' },
      provider: {
        providerType: ProviderType.MERCHANT,
        providerUid: new Types.ObjectId().toString(),
        branchId: new Types.ObjectId().toString(),
        providerName: 'Shop',
      },
      serviceLines: [],
      fulfillment: {
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
      },
      pricing: { customerTotalCentavos: 0 },
      paymentSummary: {},
      status: OrderStatus.COMPLETED,
    });

  const makePromo = async (
    overrides: Partial<{
      code: string;
      discountType: PromoDiscountType;
      discountValue: number;
      maxDiscountCentavos: number | null;
      minOrderValueCentavos: number | null;
      targetRoleIds: string[];
      firstOrderOnly: boolean;
      usageCapTotal: number | null;
      usageCapPerCustomer: number;
      startsAt: Date;
      expiresAt: Date | null;
      isActive: boolean;
      redemptionCount: number;
    }> = {},
  ) =>
    connection.models[PromoCode.name].create({
      code:
        overrides.code ?? `CODE${new Types.ObjectId().toString().slice(-6)}`,
      description: 'Test promo',
      discountType: overrides.discountType ?? PromoDiscountType.FLAT,
      discountValue: overrides.discountValue ?? 5000,
      maxDiscountCentavos: overrides.maxDiscountCentavos ?? null,
      minOrderValueCentavos: overrides.minOrderValueCentavos ?? null,
      targetRoleIds: overrides.targetRoleIds ?? ['customer'],
      firstOrderOnly: overrides.firstOrderOnly ?? false,
      usageCapTotal: overrides.usageCapTotal ?? null,
      usageCapPerCustomer: overrides.usageCapPerCustomer ?? 1,
      redemptionCount: overrides.redemptionCount ?? 0,
      startsAt: overrides.startsAt ?? new Date(Date.now() - 60_000),
      expiresAt: overrides.expiresAt ?? null,
      isActive: overrides.isActive ?? true,
      createdByUid: 'admin-uid',
      createdByName: 'Ada Reyes',
    });

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: PromoCode.name, schema: PromoCodeSchema },
          { name: PromoRedemption.name, schema: PromoRedemptionSchema },
          { name: UserVoucher.name, schema: UserVoucherSchema },
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
        ]),
      ],
      providers: [PromotionsService],
    }).compile();

    service = module.get(PromotionsService);
    connection = module.get<Connection>(getConnectionToken());
    // Claim idempotency IS a unique index. Without building it here the
    // parallel-claim test below would pass on a collection that has no
    // constraint at all — green for the wrong reason, and silent in
    // production where the index does exist.
    await connection.models[UserVoucher.name].syncIndexes();
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      PromoCode.name,
      PromoRedemption.name,
      UserVoucher.name,
      User.name,
      Role.name,
      OnlineOrder.name,
    ]) {
      await connection.models[name].deleteMany({});
    }
  });

  describe('create', () => {
    it('stores the code uppercase regardless of how it was typed', async () => {
      const promo = await service.create(
        {
          code: 'welcome10',
          description: 'Welcome offer',
          discountType: PromoDiscountType.FLAT,
          discountValue: 1000,
          targetRoleIds: ['customer'],
          startsAt: new Date(),
        },
        'admin-uid',
        'Ada Reyes',
      );

      expect(promo.code).toBe('WELCOME10');
    });

    it('refuses a duplicate code', async () => {
      await makePromo({ code: 'DUPE' });

      await expect(
        service.create(
          {
            code: 'dupe',
            description: 'x',
            discountType: PromoDiscountType.FLAT,
            discountValue: 100,
            targetRoleIds: ['customer'],
            startsAt: new Date(),
          },
          'admin-uid',
          'Ada Reyes',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // There is no legitimate reason to discount an admin's own order, and
    // allowing it would make a promo code a way to hand a colleague free money.
    it.each(['admin', 'support'])(
      'refuses to target %s accounts',
      async (roleId) => {
        await expect(
          service.create(
            {
              code: 'BAD',
              description: 'x',
              discountType: PromoDiscountType.FLAT,
              discountValue: 100,
              targetRoleIds: [roleId],
              startsAt: new Date(),
            },
            'admin-uid',
            'Ada Reyes',
          ),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('refuses a percentage discount over 100', async () => {
      await expect(
        service.create(
          {
            code: 'TOOMUCH',
            description: 'x',
            discountType: PromoDiscountType.PERCENTAGE,
            discountValue: 150,
            targetRoleIds: ['customer'],
            startsAt: new Date(),
          },
          'admin-uid',
          'Ada Reyes',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses an expiry on or before the start date', async () => {
      const startsAt = new Date();
      await expect(
        service.create(
          {
            code: 'BACKWARDS',
            description: 'x',
            discountType: PromoDiscountType.FLAT,
            discountValue: 100,
            targetRoleIds: ['customer'],
            startsAt,
            expiresAt: startsAt,
          },
          'admin-uid',
          'Ada Reyes',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // Scope and method have to agree
  //
  // Each refused pair reads as a sensible thing to want and would do something
  // else, so they are rejected at creation rather than coerced into whichever
  // interpretation the code happens to reach first.
  // ---------------------------------------------------------------------------
  describe('scope validation', () => {
    const input = (over: Partial<CreatePromoInput> = {}) => ({
      code: `SCOPE${new Types.ObjectId().toString().slice(-6)}`,
      description: 'test',
      discountType: PromoDiscountType.FLAT,
      discountValue: 5_000,
      targetRoleIds: ['customer'],
      startsAt: new Date(),
      ...over,
    });

    it('defaults an unscoped code to an order discount', async () => {
      const promo = await service.create(input(), 'admin-1', 'Admin');
      // Stored as null, READ as ORDER_TOTAL — so codes written before scopes
      // existed keep working with no migration.
      expect(scopeOf(promo)).toBe(PromoScope.ORDER_TOTAL);
    });

    it('refuses to waive an order total', async () => {
      // A free order of unbounded value. If that is really wanted it is
      // PERCENTAGE 100 with a maximum, which forces a ceiling to be named.
      await expect(
        service.create(
          input({
            scope: PromoScope.ORDER_TOTAL,
            discountType: PromoDiscountType.WAIVE,
          }),
          'admin-1',
          'Admin',
        ),
      ).rejects.toThrow(/maximum amount/i);
    });

    it('accepts a platform-fee waiver', async () => {
      const promo = await service.create(
        input({
          scope: PromoScope.PLATFORM_FEE,
          discountType: PromoDiscountType.WAIVE,
          targetRoleIds: ['merchant', 'washer'],
        }),
        'admin-1',
        'Admin',
      );
      expect(scopeOf(promo)).toBe(PromoScope.PLATFORM_FEE);
      expect(promo.discountType).toBe(PromoDiscountType.WAIVE);
    });

    it.each([PromoDiscountType.FLAT, PromoDiscountType.PERCENTAGE])(
      'refuses a partial platform-fee discount (%s) for now',
      async (discountType) => {
        // Coherent, and deliberately not enabled: it needs a rule for what
        // happens when the fee is repriced after weighing.
        await expect(
          service.create(
            input({
              scope: PromoScope.PLATFORM_FEE,
              discountType,
              discountValue: 50,
            }),
            'admin-1',
            'Admin',
          ),
        ).rejects.toThrow(/waive the fee in full/i);
      },
    );

    it('refuses firstOrderOnly on a platform-fee promotion', async () => {
      // Customer vocabulary applied to a provider — it would silently never
      // match rather than doing something wrong, which is worse.
      await expect(
        service.create(
          input({
            scope: PromoScope.PLATFORM_FEE,
            discountType: PromoDiscountType.WAIVE,
            firstOrderOnly: true,
          }),
          'admin-1',
          'Admin',
        ),
      ).rejects.toThrow(/first order/i);
    });
  });

  describe('computeStatus', () => {
    it('is disabled when isActive is false, above every other condition', async () => {
      const promo = await makePromo({ isActive: false, usageCapTotal: 100 });
      expect(computeStatus(promo)).toBe('disabled');
    });

    it('is scheduled before startsAt', async () => {
      const promo = await makePromo({
        startsAt: new Date(Date.now() + 60_000),
      });
      expect(computeStatus(promo)).toBe('scheduled');
    });

    it('is expired after expiresAt', async () => {
      const promo = await makePromo({
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(computeStatus(promo)).toBe('expired');
    });

    it('is exhausted once redemptionCount reaches the cap', async () => {
      const promo = await makePromo({ usageCapTotal: 5, redemptionCount: 5 });
      expect(computeStatus(promo)).toBe('exhausted');
    });

    it('is active otherwise', async () => {
      const promo = await makePromo();
      expect(computeStatus(promo)).toBe('active');
    });
  });

  describe('validate', () => {
    it('is invalid for a code that does not exist', async () => {
      const result = await service.validate('NOPE', 'uid', 10_000);
      expect(result.valid).toBe(false);
      expect(result.discountCentavos).toBe(0);
    });

    it('computes a flat discount, never more than the order total', async () => {
      const uid = await makeCustomer();
      await makePromo({ code: 'FLAT50', discountValue: 5000 });

      const cheap = await service.validate('FLAT50', uid, 3000);
      expect(cheap.valid).toBe(true);
      expect(cheap.discountCentavos).toBe(3000);

      const expensive = await service.validate('FLAT50', uid, 20_000);
      expect(expensive.discountCentavos).toBe(5000);
    });

    it('computes a percentage discount, capped by maxDiscountCentavos', async () => {
      const uid = await makeCustomer();
      await makePromo({
        code: 'PCT20',
        discountType: PromoDiscountType.PERCENTAGE,
        discountValue: 20,
        maxDiscountCentavos: 1000,
      });

      // 20% of 10,000 is 2,000, but the cap is 1,000.
      const result = await service.validate('PCT20', uid, 10_000);
      expect(result.discountCentavos).toBe(1000);

      // 20% of 2,000 is 400, under the cap — the cap should not apply.
      const small = await service.validate('PCT20', uid, 2000);
      expect(small.discountCentavos).toBe(400);
    });

    it('refuses a disabled code', async () => {
      const uid = await makeCustomer();
      await makePromo({ code: 'OFF', isActive: false });
      expect((await service.validate('OFF', uid, 10_000)).valid).toBe(false);
    });

    it('refuses a code before its start date', async () => {
      const uid = await makeCustomer();
      await makePromo({
        code: 'FUTURE',
        startsAt: new Date(Date.now() + 60_000),
      });
      expect((await service.validate('FUTURE', uid, 10_000)).valid).toBe(false);
    });

    it('refuses an expired code', async () => {
      const uid = await makeCustomer();
      await makePromo({
        code: 'GONE',
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect((await service.validate('GONE', uid, 10_000)).valid).toBe(false);
    });

    it('refuses a code that has hit its total cap', async () => {
      const uid = await makeCustomer();
      await makePromo({
        code: 'FULL',
        usageCapTotal: 5,
        redemptionCount: 5,
      });
      expect((await service.validate('FULL', uid, 10_000)).valid).toBe(false);
    });

    it('refuses an order below the minimum', async () => {
      const uid = await makeCustomer();
      await makePromo({ code: 'MIN', minOrderValueCentavos: 5000 });
      expect((await service.validate('MIN', uid, 3000)).valid).toBe(false);
      expect((await service.validate('MIN', uid, 5000)).valid).toBe(true);
    });

    it('refuses an account whose role is not targeted', async () => {
      const washerRole = await makeRole('washer');
      const uid = new Types.ObjectId().toString();
      await connection.models[User.name].create({
        _id: uid,
        firstName: 'Wendy',
        lastName: 'Washer',
        email: `${uid}@example.com`,
        phoneNumber: '09171234567',
        role: washerRole._id,
      });
      await makePromo({ code: 'CUSTOMERONLY', targetRoleIds: ['customer'] });

      expect((await service.validate('CUSTOMERONLY', uid, 10_000)).valid).toBe(
        false,
      );
    });

    it('enforces firstOrderOnly against real order history', async () => {
      const uid = await makeCustomer();
      await makePromo({ code: 'FIRSTORDER', firstOrderOnly: true });

      expect((await service.validate('FIRSTORDER', uid, 10_000)).valid).toBe(
        true,
      );

      await makeOrder(uid);

      expect((await service.validate('FIRSTORDER', uid, 10_000)).valid).toBe(
        false,
      );
    });

    it('enforces the per-customer cap against real redemption history', async () => {
      const uid = await makeCustomer();
      const promo = await makePromo({
        code: 'ONCE',
        usageCapPerCustomer: 1,
      });

      await service.redeem({
        code: 'ONCE',
        customerUid: uid,
        orderTotalCentavos: 10_000,
      });

      const result = await service.validate('ONCE', uid, 10_000);
      expect(result.valid).toBe(false);
      void promo;
    });
  });

  describe('redeem', () => {
    it('records a redemption and increments the running total', async () => {
      const uid = await makeCustomer('Cara');
      const promo = await makePromo({ code: 'REDEEM1', discountValue: 2000 });

      const redemption = await service.redeem({
        code: 'REDEEM1',
        customerUid: uid,
        orderTotalCentavos: 10_000,
        orderId: 'order-123',
      });

      expect(redemption.discountAppliedCentavos).toBe(2000);
      expect(redemption.customerName).toBe('Cara Test');
      expect(redemption.orderId).toBe('order-123');

      const updated = await service.findOne(String(promo._id));
      expect(updated.redemptionCount).toBe(1);
    });

    it('re-validates rather than trusting a prior check — refuses an invalid redemption', async () => {
      const uid = await makeCustomer();
      await makePromo({ code: 'DISABLED2', isActive: false });

      await expect(
        service.redeem({
          code: 'DISABLED2',
          customerUid: uid,
          orderTotalCentavos: 10_000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws for a code that does not exist', async () => {
      const uid = await makeCustomer();
      await expect(
        service.redeem({
          code: 'NOPE',
          customerUid: uid,
          orderTotalCentavos: 10_000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    // The whole point of the conditional update: two redemptions racing for
    // the last slot in the cap must not both succeed.
    it('refuses a redemption that would exceed the total cap, even mid-race', async () => {
      const promo = await makePromo({
        code: 'LASTONE',
        usageCapTotal: 1,
        redemptionCount: 0,
      });
      const uidA = await makeCustomer('A');
      const uidB = await makeCustomer('B');

      // Simulate the second caller having already taken the slot between
      // this caller's validate() and its own write.
      await connection.models[PromoCode.name].updateOne(
        { _id: promo._id },
        { $set: { redemptionCount: 1 } },
      );

      await expect(
        service.redeem({
          code: 'LASTONE',
          customerUid: uidA,
          orderTotalCentavos: 10_000,
        }),
      ).rejects.toThrow(BadRequestException); // caught by validate() first

      // Directly exercise the DB-level race guard: force redemptionCount
      // back under the cap so validate() passes, but have the conditional
      // update lose anyway by racing it against a concurrent increment.
      await connection.models[PromoCode.name].updateOne(
        { _id: promo._id },
        { $set: { redemptionCount: 0 } },
      );
      const [first, second] = await Promise.allSettled([
        service.redeem({
          code: 'LASTONE',
          customerUid: uidA,
          orderTotalCentavos: 10_000,
        }),
        service.redeem({
          code: 'LASTONE',
          customerUid: uidB,
          orderTotalCentavos: 10_000,
        }),
      ]);
      const outcomes = [first.status, second.status];
      expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((s) => s === 'rejected')).toHaveLength(1);

      const final = await service.findOne(String(promo._id));
      expect(final.redemptionCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Reservation lifecycle
  //
  // Before this existed, a redemption row was written the moment an order was
  // created and nothing could ever undo it. A customer whose order the provider
  // then REJECTED lost the code permanently — the global cap and their own
  // per-customer cap were both consumed by an order that never happened.
  // ---------------------------------------------------------------------------
  describe('reserve / settle / release', () => {
    const redemptionsFor = (orderId: string) =>
      connection.models[PromoRedemption.name].find({ orderId }).exec();

    it('reserve holds the slot and still counts against the total cap', async () => {
      const uid = await makeCustomer('Rita');
      const promo = await makePromo({ code: 'HOLD1', discountValue: 2000 });

      const r = await service.reserve({
        code: 'HOLD1',
        customerUid: uid,
        orderTotalCentavos: 10_000,
        orderId: 'order-hold-1',
      });

      expect(r.status).toBe(PromoRedemptionStatus.RESERVED);
      // A held slot is a spent slot until it is released — reserving must not
      // be a way to over-issue.
      expect((await service.findOne(String(promo._id))).redemptionCount).toBe(
        1,
      );
    });

    it('releasing hands the slot back and lets the customer use the code again', async () => {
      const uid = await makeCustomer('Rex');
      const promo = await makePromo({
        code: 'REJECT1',
        discountValue: 2000,
        usageCapPerCustomer: 1,
      });

      await service.reserve({
        code: 'REJECT1',
        customerUid: uid,
        orderTotalCentavos: 10_000,
        orderId: 'order-rejected',
      });

      // While held, the customer is at their cap.
      const blocked = await service.validate('REJECT1', uid, 10_000);
      expect(blocked.valid).toBe(false);

      const released = await service.releaseForOrder('order-rejected');
      expect(released).toBe(1);

      expect((await service.findOne(String(promo._id))).redemptionCount).toBe(
        0,
      );
      // This is the bug in one assertion: a rejected order must not cost the
      // customer their code.
      const after = await service.validate('REJECT1', uid, 10_000);
      expect(after.valid).toBe(true);
    });

    it('settling makes the slot permanent', async () => {
      const uid = await makeCustomer('Sam');
      const promo = await makePromo({
        code: 'DONE1',
        discountValue: 2000,
        usageCapPerCustomer: 1,
      });

      await service.reserve({
        code: 'DONE1',
        customerUid: uid,
        orderTotalCentavos: 10_000,
        orderId: 'order-done',
      });
      expect(await service.settleForOrder('order-done')).toBe(1);

      const [row] = await redemptionsFor('order-done');
      expect(row.status).toBe(PromoRedemptionStatus.REDEEMED);
      expect((await service.findOne(String(promo._id))).redemptionCount).toBe(
        1,
      );
      expect((await service.validate('DONE1', uid, 10_000)).valid).toBe(false);
    });

    it('a settled slot can no longer be released', async () => {
      const uid = await makeCustomer('Sara');
      const promo = await makePromo({ code: 'DONE2', discountValue: 2000 });

      await service.reserve({
        code: 'DONE2',
        customerUid: uid,
        orderTotalCentavos: 10_000,
        orderId: 'order-done-2',
      });
      await service.settleForOrder('order-done-2');

      expect(await service.releaseForOrder('order-done-2')).toBe(0);
      expect((await service.findOne(String(promo._id))).redemptionCount).toBe(
        1,
      );
    });

    it('releasing twice does not decrement the count twice', async () => {
      // Order transitions get retried. A release that double-decremented would
      // hand out free slots on every retry.
      const uid = await makeCustomer('Dee');
      const promo = await makePromo({ code: 'TWICE1', discountValue: 2000 });

      await service.reserve({
        code: 'TWICE1',
        customerUid: uid,
        orderTotalCentavos: 10_000,
        orderId: 'order-twice',
      });

      expect(await service.releaseForOrder('order-twice')).toBe(1);
      expect(await service.releaseForOrder('order-twice')).toBe(0);
      expect((await service.findOne(String(promo._id))).redemptionCount).toBe(
        0,
      );
    });

    it('an admin direct grant is REDEEMED from birth and no order can release it', async () => {
      const uid = await makeCustomer('Gia');
      const promo = await makePromo({ code: 'GRANT1', discountValue: 2000 });

      const granted = await service.redeem({
        code: 'GRANT1',
        customerUid: uid,
        orderTotalCentavos: 10_000,
        orderId: 'order-granted',
      });

      expect(granted.status).toBe(PromoRedemptionStatus.REDEEMED);
      expect(await service.releaseForOrder('order-granted')).toBe(0);
      expect((await service.findOne(String(promo._id))).redemptionCount).toBe(
        1,
      );
    });

    it('legacy rows with no status still count against the per-customer cap', async () => {
      // Everything written before the lifecycle existed has no `status`. The
      // cap query matches on "not RELEASED" precisely so those keep counting
      // without needing a backfill first.
      const uid = await makeCustomer('Old');
      const promo = await makePromo({
        code: 'LEGACY1',
        discountValue: 2000,
        usageCapPerCustomer: 1,
        redemptionCount: 1,
      });

      await connection.models[PromoRedemption.name].create({
        promoId: String(promo._id),
        code: 'LEGACY1',
        customerUid: uid,
        customerName: 'Old Test',
        orderId: 'legacy-order',
        discountAppliedCentavos: 2000,
        // no status — exactly as the old code wrote it
      });

      expect((await service.validate('LEGACY1', uid, 10_000)).valid).toBe(
        false,
      );
      // And it is not releasable, because it was never reserved.
      expect(await service.releaseForOrder('legacy-order')).toBe(0);
    });

    it('release is scoped to the order — other orders keep their slots', async () => {
      const a = await makeCustomer('Ann');
      const b = await makeCustomer('Ben');
      const promo = await makePromo({
        code: 'SCOPED1',
        discountValue: 2000,
        usageCapPerCustomer: 1,
      });

      await service.reserve({
        code: 'SCOPED1',
        customerUid: a,
        orderTotalCentavos: 10_000,
        orderId: 'order-a',
      });
      await service.reserve({
        code: 'SCOPED1',
        customerUid: b,
        orderTotalCentavos: 10_000,
        orderId: 'order-b',
      });

      await service.releaseForOrder('order-a');

      expect((await service.findOne(String(promo._id))).redemptionCount).toBe(
        1,
      );
      expect((await service.validate('SCOPED1', a, 10_000)).valid).toBe(true);
      expect((await service.validate('SCOPED1', b, 10_000)).valid).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Partner incentives are counted per BRANCH
  //
  // "First five orders with no platform fee" is a promise about a shop. Keyed
  // on the owner's login instead, a merchant with three branches would get
  // five between them — and the owner would have no way to tell which branch
  // used them.
  // ---------------------------------------------------------------------------
  describe('platform-fee promotions', () => {
    const feePromo = (over: Partial<CreatePromoInput> = {}) =>
      service.create(
        {
          code: `FEE${new Types.ObjectId().toString().slice(-6)}`,
          description: 'Launch incentive',
          scope: PromoScope.PLATFORM_FEE,
          discountType: PromoDiscountType.WAIVE,
          discountValue: 0,
          targetRoleIds: ['merchant', 'washer'],
          usageCapPerSubject: 2,
          startsAt: new Date(Date.now() - 60_000),
          ...over,
        },
        'admin-1',
        'Admin',
      );

    const reserve = (promoId: string, branchId: string, orderId: string) =>
      service.reserveForBranch({
        promoId,
        branchId,
        orderId,
        actorUid: 'owner-1',
        actorName: 'Owner',
        discountCentavos: 5_000,
      });

    it('finds an active incentive for a targeted role', async () => {
      const promo = await feePromo();
      const found = await service.findPlatformFeePromoFor(
        'merchant',
        'branch-a',
      );
      expect(found && String(found._id)).toBe(String(promo._id));
    });

    it('does not offer it to a role it does not target', async () => {
      await feePromo({ targetRoleIds: ['merchant'] });
      expect(
        await service.findPlatformFeePromoFor('washer', 'branch-a'),
      ).toBeNull();
    });

    it('ignores order-total codes entirely', async () => {
      // A customer discount must never be auto-applied to a provider's fee.
      await service.create(
        {
          code: 'CUSTONLY',
          description: 'customer code',
          discountType: PromoDiscountType.FLAT,
          discountValue: 5_000,
          targetRoleIds: ['merchant'],
          startsAt: new Date(Date.now() - 60_000),
        },
        'admin-1',
        'Admin',
      );
      expect(
        await service.findPlatformFeePromoFor('merchant', 'branch-a'),
      ).toBeNull();
    });

    it('counts the cap per branch, not per chain', async () => {
      const promo = await feePromo({ usageCapPerSubject: 2 });
      const id = String(promo._id);

      await reserve(id, 'branch-a', 'order-1');
      await reserve(id, 'branch-a', 'order-2');
      // Branch A is done...
      expect(
        await service.findPlatformFeePromoFor('merchant', 'branch-a'),
      ).toBeNull();
      // ...and branch B of the same business still has its own two.
      expect(
        await service.findPlatformFeePromoFor('merchant', 'branch-b'),
      ).not.toBeNull();
    });

    it('honours the older per-customer cap when no per-subject cap is set', async () => {
      // Codes written before subjects existed carry only usageCapPerCustomer.
      // Reading it through capPerSubject is what lets them keep working
      // without a migration running first.
      const promo = await feePromo({
        usageCapPerSubject: undefined,
        usageCapPerCustomer: 1,
      });
      const id = String(promo._id);
      await reserve(id, 'branch-a', 'order-1');
      expect(
        await service.findPlatformFeePromoFor('merchant', 'branch-a'),
      ).toBeNull();
    });

    it('stops offering it once the platform-wide cap is gone', async () => {
      const promo = await feePromo({ usageCapTotal: 1, usageCapPerSubject: 5 });
      const id = String(promo._id);
      await reserve(id, 'branch-a', 'order-1');
      expect(
        await service.findPlatformFeePromoFor('merchant', 'branch-b'),
      ).toBeNull();
    });

    it('refuses to hand out more than the platform-wide cap under contention', async () => {
      // Two branches racing for one remaining slot: exactly one gets it.
      const promo = await feePromo({ usageCapTotal: 1, usageCapPerSubject: 5 });
      const id = String(promo._id);
      const [a, b] = await Promise.all([
        reserve(id, 'branch-a', 'order-a'),
        reserve(id, 'branch-b', 'order-b'),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await service.findOne(id)).redemptionCount).toBe(1);
    });

    it('gives the slot back when the order is released', async () => {
      const promo = await feePromo({ usageCapPerSubject: 1 });
      const id = String(promo._id);
      await reserve(id, 'branch-a', 'order-1');
      expect(
        await service.findPlatformFeePromoFor('merchant', 'branch-a'),
      ).toBeNull();

      await service.releaseForOrder('order-1');
      expect(
        await service.findPlatformFeePromoFor('merchant', 'branch-a'),
      ).not.toBeNull();
    });

    it('records the branch as the subject', async () => {
      const promo = await feePromo();
      const row = await reserve(String(promo._id), 'branch-a', 'order-1');
      expect(row?.subjectType).toBe(RedemptionSubjectType.BRANCH);
      expect(row?.subjectId).toBe('branch-a');
      expect(row?.status).toBe(PromoRedemptionStatus.RESERVED);
    });
  });

  // ---------------------------------------------------------------------------
  // Held vouchers
  //
  // Entitlement only. Claiming grants no money and skips no checks — the same
  // validate() runs at checkout whether the code was claimed or typed.
  // ---------------------------------------------------------------------------
  describe('claim / vouchersFor', () => {
    it('claiming twice yields ONE entitlement', async () => {
      // Idempotent by unique index, not by a disabled button — a double tap
      // and a retried request are the same thing to the database.
      const uid = await makeCustomer('Vera');
      const promo = await makePromo({ code: 'CLAIM1' });

      const first = await service.claim(String(promo._id), uid);
      const second = await service.claim(String(promo._id), uid);

      expect(String(first._id)).toBe(String(second._id));
      expect(await service.vouchersFor(uid)).toHaveLength(1);
    });

    it('enforces one entitlement per holder at the DATABASE level', async () => {
      // Proves the constraint exists rather than inferring it from the happy
      // path: a direct insert bypassing claim() must be refused.
      const uid = await makeCustomer('Ida');
      const promo = await makePromo({ code: 'IDX1' });
      await service.claim(String(promo._id), uid);

      await expect(
        connection.models[UserVoucher.name].create({
          promoId: String(promo._id),
          code: 'IDX1',
          subjectType: 'CUSTOMER',
          subjectId: uid,
          claimedAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('claiming in parallel still yields ONE entitlement', async () => {
      const uid = await makeCustomer('Vic');
      const promo = await makePromo({ code: 'CLAIM2' });

      await Promise.all([
        service.claim(String(promo._id), uid),
        service.claim(String(promo._id), uid),
        service.claim(String(promo._id), uid),
      ]);

      expect(await service.vouchersFor(uid)).toHaveLength(1);
    });

    it('refuses to claim a promotion that is no longer live', async () => {
      // Otherwise it would sit in the list looking like something they own.
      const uid = await makeCustomer('Von');
      const promo = await makePromo({ code: 'DEAD1', isActive: false });
      await expect(service.claim(String(promo._id), uid)).rejects.toThrow(
        /no longer available/i,
      );
    });

    it('reports a fresh voucher as available with its uses left', async () => {
      const uid = await makeCustomer('Val');
      const promo = await makePromo({ code: 'FRESH1', usageCapPerCustomer: 2 });
      await service.claim(String(promo._id), uid);

      const [view] = await service.vouchersFor(uid);
      expect(view.status).toBe(UserVoucherStatus.AVAILABLE);
      expect(view.usesRemaining).toBe(2);
      expect(view.code).toBe('FRESH1');
    });

    it('reads as USED once the holder has spent their allowance', async () => {
      const uid = await makeCustomer('Ula');
      const promo = await makePromo({ code: 'SPENT1', usageCapPerCustomer: 1 });
      await service.claim(String(promo._id), uid);
      await service.redeem({
        code: 'SPENT1',
        customerUid: uid,
        orderTotalCentavos: 50_000,
      });

      const [view] = await service.vouchersFor(uid);
      expect(view.status).toBe(UserVoucherStatus.USED);
      expect(view.usesRemaining).toBe(0);
    });

    it('becomes available again when a reservation is released', async () => {
      // The status is DERIVED from the ledger, so a cancelled order restores
      // the voucher with nothing to keep in step. A stored status would need
      // the cancel path to remember to update it.
      const uid = await makeCustomer('Rey');
      const promo = await makePromo({ code: 'BACK1', usageCapPerCustomer: 1 });
      await service.claim(String(promo._id), uid);
      await service.reserve({
        code: 'BACK1',
        customerUid: uid,
        orderTotalCentavos: 50_000,
        orderId: 'order-back-1',
      });
      expect((await service.vouchersFor(uid))[0].status).toBe(
        UserVoucherStatus.USED,
      );

      await service.releaseForOrder('order-back-1');
      expect((await service.vouchersFor(uid))[0].status).toBe(
        UserVoucherStatus.AVAILABLE,
      );
    });

    it('reads as EXPIRED once the promotion ends, even with uses left', async () => {
      const uid = await makeCustomer('Eli');
      const promo = await makePromo({ code: 'EXP1', usageCapPerCustomer: 3 });
      await service.claim(String(promo._id), uid);
      await service.setActive(String(promo._id), false);

      const [view] = await service.vouchersFor(uid);
      // The more useful thing to say is why it cannot be used NOW.
      expect(view.status).toBe(UserVoucherStatus.EXPIRED);
    });

    it('revoking beats the promotion still being live', async () => {
      const uid = await makeCustomer('Ria');
      const promo = await makePromo({ code: 'REV1' });
      const voucher = await service.claim(String(promo._id), uid);
      await service.revokeVoucher(String(voucher._id));

      const [view] = await service.vouchersFor(uid);
      expect(view.status).toBe(UserVoucherStatus.REVOKED);
    });

    it("shows one holder nothing of another holder's", async () => {
      const mine = await makeCustomer('Mia');
      const theirs = await makeCustomer('Tim');
      const promo = await makePromo({ code: 'MINE1' });
      await service.claim(String(promo._id), mine);

      expect(await service.vouchersFor(mine)).toHaveLength(1);
      expect(await service.vouchersFor(theirs)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Checkout eligibility
  //
  // The picker renders this answer rather than deriving one, and it comes from
  // the same validate() the checkout runs — so a voucher the picker offers
  // cannot be refused a moment later, and one it greys out cannot turn out to
  // have been fine.
  // ---------------------------------------------------------------------------
  describe('vouchersFor — eligibility', () => {
    it('is usable, with the amount it would take off', async () => {
      const uid = await makeCustomer('Ada');
      const promo = await makePromo({ code: 'FIT1', discountValue: 10_000 });
      await service.claim(String(promo._id), uid);

      const [v] = await service.vouchersFor(uid, undefined, 50_000);
      expect(v.usable).toBe(true);
      expect(v.unusableReason).toBeNull();
      expect(v.discountPreviewCentavos).toBe(10_000);
    });

    it('refuses an order under the minimum, and says the minimum', async () => {
      const uid = await makeCustomer('Ben');
      const promo = await makePromo({
        code: 'MIN1',
        discountValue: 10_000,
        minOrderValueCentavos: 30_000,
      });
      await service.claim(String(promo._id), uid);

      const [v] = await service.vouchersFor(uid, undefined, 20_000);
      expect(v.usable).toBe(false);
      expect(v.unusableReason).toMatch(/minimum/i);
      expect(v.discountPreviewCentavos).toBeNull();
    });

    it('enforces first-order-only, which no client could check', async () => {
      // The order history is not on the device. This is the case that makes
      // server-side eligibility necessary rather than merely tidier.
      const uid = await makeCustomer('Cal');
      const promo = await makePromo({ code: 'FIRST1', firstOrderOnly: true });
      await service.claim(String(promo._id), uid);
      await makeOrder(uid);

      const [v] = await service.vouchersFor(uid, undefined, 50_000);
      expect(v.usable).toBe(false);
      expect(v.unusableReason).toMatch(/first order/i);
    });

    it('caps the preview the same way checkout will', async () => {
      const uid = await makeCustomer('Dot');
      const promo = await makePromo({
        code: 'CAP1',
        discountType: PromoDiscountType.PERCENTAGE,
        discountValue: 20,
        maxDiscountCentavos: 10_000,
      });
      await service.claim(String(promo._id), uid);

      // 20% of ₱1,000 is ₱200, capped at ₱100.
      const [v] = await service.vouchersFor(uid, undefined, 100_000);
      expect(v.discountPreviewCentavos).toBe(10_000);
    });

    it('explains a spent voucher instead of leaving it blank', async () => {
      const uid = await makeCustomer('Eve');
      const promo = await makePromo({ code: 'GONE1', usageCapPerCustomer: 1 });
      await service.claim(String(promo._id), uid);
      await service.redeem({
        code: 'GONE1',
        customerUid: uid,
        orderTotalCentavos: 50_000,
      });

      const [v] = await service.vouchersFor(uid, undefined, 50_000);
      expect(v.status).toBe(UserVoucherStatus.USED);
      expect(v.usable).toBe(false);
      expect(v.unusableReason).toMatch(/already used/i);
    });

    it('never offers a platform-fee incentive to a customer', async () => {
      // A backstop: a fee incentive belongs to a provider and can never come
      // off a customer's order. Offering one would be showing a customer
      // somebody else's money.
      const uid = await makeCustomer('Fay');
      const promo = await service.create(
        {
          code: 'FEEONLY',
          description: 'partner incentive',
          scope: PromoScope.PLATFORM_FEE,
          discountType: PromoDiscountType.WAIVE,
          discountValue: 0,
          targetRoleIds: ['merchant'],
          startsAt: new Date(Date.now() - 60_000),
        },
        'admin-1',
        'Admin',
      );
      await service.claim(String(promo._id), uid);

      const [v] = await service.vouchersFor(uid, undefined, 50_000);
      expect(v.usable).toBe(false);
      expect(v.unusableReason).toMatch(/provider fees/i);
    });

    it('answers the simpler question when there is no order yet', async () => {
      // The My Vouchers screen has nothing to price against, so "usable" means
      // "live" and the amount stays unknown rather than being guessed.
      const uid = await makeCustomer('Gus');
      const promo = await makePromo({
        code: 'NOORD1',
        minOrderValueCentavos: 30_000,
      });
      await service.claim(String(promo._id), uid);

      const [v] = await service.vouchersFor(uid);
      expect(v.usable).toBe(true);
      expect(v.discountPreviewCentavos).toBeNull();
    });
  });

  describe('usageSummary', () => {
    it('totals redemptions, unique customers and discount given', async () => {
      const promo = await makePromo({ code: 'SUMMARY', discountValue: 1000 });
      const uidA = await makeCustomer('A');
      const uidB = await makeCustomer('B');
      await service.redeem({
        code: 'SUMMARY',
        customerUid: uidA,
        orderTotalCentavos: 10_000,
      });
      await connection.models[PromoCode.name].updateOne(
        { _id: promo._id },
        { $set: { usageCapPerCustomer: 5 } },
      );
      await service.redeem({
        code: 'SUMMARY',
        customerUid: uidB,
        orderTotalCentavos: 10_000,
      });

      const summary = await service.usageSummary(String(promo._id));
      expect(summary.totalRedemptions).toBe(2);
      expect(summary.uniqueCustomers).toBe(2);
      expect(summary.totalDiscountCentavos).toBe(2000);
    });

    it('reports nobody over cap under normal enforcement', async () => {
      const promo = await makePromo({ code: 'CLEAN' });
      const uid = await makeCustomer();
      await service.redeem({
        code: 'CLEAN',
        customerUid: uid,
        orderTotalCentavos: 10_000,
      });

      const summary = await service.usageSummary(String(promo._id));
      expect(summary.overCapCustomers).toEqual([]);
    });

    // Should never happen through normal enforcement — this is the integrity
    // check for if it somehow does (a bug, a direct database write).
    it('flags a customer who exceeded their per-customer cap', async () => {
      const promo = await makePromo({
        code: 'BYPASSED',
        usageCapPerCustomer: 1,
      });
      const uid = await makeCustomer('Over');
      // Written directly, bypassing redeem()'s enforcement — simulating the
      // scenario this check exists to catch.
      await connection.models[PromoRedemption.name].create([
        {
          promoId: String(promo._id),
          code: 'BYPASSED',
          customerUid: uid,
          customerName: 'Over Test',
          discountAppliedCentavos: 1000,
        },
        {
          promoId: String(promo._id),
          code: 'BYPASSED',
          customerUid: uid,
          customerName: 'Over Test',
          discountAppliedCentavos: 1000,
        },
      ]);

      const summary = await service.usageSummary(String(promo._id));
      expect(summary.overCapCustomers).toHaveLength(1);
      expect(summary.overCapCustomers[0]).toMatchObject({
        customerUid: uid,
        redemptionCount: 2,
      });
    });
  });

  describe('setActive', () => {
    it('toggles the kill switch independent of the date window', async () => {
      const promo = await makePromo({ code: 'TOGGLE' });

      const off = await service.setActive(String(promo._id), false);
      expect(off.isActive).toBe(false);

      const on = await service.setActive(String(promo._id), true);
      expect(on.isActive).toBe(true);
    });

    it('throws for a promo that does not exist', async () => {
      await expect(
        service.setActive(new Types.ObjectId().toString(), false),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('find', () => {
    it('filters by computed status', async () => {
      await makePromo({ code: 'A1', isActive: true });
      await makePromo({ code: 'A2', isActive: false });

      expect((await service.find({ status: 'active' })).total).toBe(1);
      expect((await service.find({ status: 'disabled' })).total).toBe(1);
    });

    it('finds by code or description, case-insensitively', async () => {
      await makePromo({ code: 'FINDME' });

      expect((await service.find({ search: 'findme' })).total).toBe(1);
      expect((await service.find({ search: 'nope' })).total).toBe(0);
    });
  });
});
