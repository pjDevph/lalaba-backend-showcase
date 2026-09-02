import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';

import {
  PromoCode,
  PromoCodeDocument,
  PromoDiscountType,
  PromoScope,
  capPerSubject,
  scopeOf,
} from './schemas/promo-code.schema';
import {
  PromoRedemption,
  PromoRedemptionDocument,
  PromoRedemptionStatus,
  RedemptionSubjectType,
} from './schemas/promo-redemption.schema';
import {
  UserVoucher,
  UserVoucherDocument,
  UserVoucherStatus,
} from './schemas/user-voucher.schema';
import { UserVoucherView } from './models/user-voucher.model';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  CreatePromoInput,
  PromoFilterInput,
  RedeemPromoInput,
  UpdatePromoInput,
} from './dto/create-promo.input';
import {
  PaginatedPromoCodes,
  PromoRedeemer,
  PromoUsageSummary,
  PromoValidation,
} from './models/promo.models';

const BACK_OFFICE_ROLES = new Set(['admin', 'support']);

@Injectable()
export class PromotionsService {
  constructor(
    @InjectModel(PromoCode.name)
    private readonly promoModel: Model<PromoCodeDocument>,
    @InjectModel(PromoRedemption.name)
    private readonly redemptionModel: Model<PromoRedemptionDocument>,
    @InjectModel(UserVoucher.name)
    private readonly userVoucherModel: Model<UserVoucherDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async create(
    input: CreatePromoInput,
    actorUid: string,
    actorName: string,
  ): Promise<PromoCode> {
    if (input.targetRoleIds.some((r) => BACK_OFFICE_ROLES.has(r))) {
      throw new BadRequestException(
        'Promo codes cannot target admin or support accounts',
      );
    }
    if (
      input.discountType === PromoDiscountType.PERCENTAGE &&
      input.discountValue > 100
    ) {
      throw new BadRequestException('A percentage discount cannot exceed 100');
    }
    if (input.expiresAt && input.expiresAt <= input.startsAt) {
      throw new BadRequestException('Expiry must be after the start date');
    }
    assertScopeAndMethodAgree(input);

    try {
      return await this.promoModel.create({
        ...input,
        firstOrderOnly: input.firstOrderOnly ?? false,
        usageCapPerCustomer: input.usageCapPerCustomer ?? 1,
        createdByUid: actorUid,
        createdByName: actorName,
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        throw new BadRequestException(
          `A promo code "${input.code.toUpperCase()}" already exists`,
        );
      }
      throw err;
    }
  }

  async update(id: string, input: UpdatePromoInput): Promise<PromoCode> {
    const promo = await this.promoModel.findById(id).exec();
    if (!promo) throw new NotFoundException('Promo code not found');

    const expiresAt = input.expiresAt ?? promo.expiresAt;
    const startsAt = input.startsAt ?? promo.startsAt;
    if (expiresAt && expiresAt <= startsAt) {
      throw new BadRequestException('Expiry must be after the start date');
    }

    const updated = await this.promoModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    return updated!;
  }

  async setActive(id: string, isActive: boolean): Promise<PromoCode> {
    const updated = await this.promoModel
      .findByIdAndUpdate(id, { $set: { isActive } }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Promo code not found');
    return updated;
  }

  async find(filter: PromoFilterInput = {}): Promise<PaginatedPromoCodes> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const query: Record<string, unknown> = {};
    if (filter.search?.trim()) {
      const term = filter.search.trim().toUpperCase();
      query.$or = [
        { code: { $regex: escapeRegex(term), $options: 'i' } },
        {
          description: {
            $regex: escapeRegex(filter.search.trim()),
            $options: 'i',
          },
        },
      ];
    }

    const [rows, total] = await Promise.all([
      this.promoModel.find(query).sort({ createdAt: -1 }).exec(),
      this.promoModel.countDocuments(query).exec(),
    ]);

    // Status is computed, not stored, so filtering by it happens after the
    // fetch — same pattern as the wallet list's health filter. Acceptable at
    // this scale: promo codes number in the tens to low hundreds, not
    // thousands, so this is bounded by how many campaigns exist, not traffic.
    const filtered = filter.status
      ? rows.filter((p) => computeStatus(p) === filter.status)
      : rows;

    return {
      data: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }

  async findOne(id: string): Promise<PromoCode> {
    const promo = await this.promoModel.findById(id).exec();
    if (!promo) throw new NotFoundException('Promo code not found');
    return promo;
  }

  /**
   * Would this code work right now, for this person? No side effects — the
   * admin panel uses this to preview a code, and `redeem` re-runs the exact
   * same checks rather than trusting a stale validation result from a moment
   * earlier.
   */
  async validate(
    code: string,
    customerUid: string,
    orderTotalCentavos: number,
  ): Promise<PromoValidation> {
    const promo = await this.promoModel
      .findOne({ code: code.trim().toUpperCase() })
      .exec();
    if (!promo) return invalid('Code not found');
    return this.validateAgainst(promo, customerUid, orderTotalCentavos);
  }

  private async validateAgainst(
    promo: PromoCodeDocument,
    customerUid: string,
    orderTotalCentavos: number,
  ): Promise<PromoValidation> {
    const now = new Date();

    if (!promo.isActive) return invalid('This code has been turned off');
    if (now < promo.startsAt) return invalid('This code is not active yet');
    if (promo.expiresAt && now > promo.expiresAt)
      return invalid('This code has expired');
    if (
      promo.usageCapTotal != null &&
      promo.redemptionCount >= promo.usageCapTotal
    ) {
      return invalid('This code has been fully redeemed');
    }
    if (
      promo.minOrderValueCentavos != null &&
      orderTotalCentavos < promo.minOrderValueCentavos
    ) {
      return invalid('Order does not meet the minimum for this code');
    }

    const customer = await this.userModel
      .findById(customerUid)
      .populate('role')
      .exec();
    if (!customer) return invalid('Account not found');
    const roleId = (customer.role as unknown as Role | undefined)?.roleId;
    if (!roleId || !promo.targetRoleIds.includes(roleId)) {
      return invalid('This code is not available for your account type');
    }

    if (promo.firstOrderOnly) {
      const hasOrdered = await this.orderModel
        .exists({ 'customer.uid': customerUid })
        .exec();
      if (hasOrdered)
        return invalid('This code is only valid on your first order');
    }

    // `$ne: RELEASED` rather than `$in: [RESERVED, REDEEMED]` — a $ne match
    // also matches documents with no `status` at all, which is every row
    // written before the lifecycle existed. Legacy redemptions therefore keep
    // counting exactly as they did, with no backfill required first.
    const priorRedemptions = await this.redemptionModel
      .countDocuments({
        promoId: String(promo._id),
        customerUid,
        status: { $ne: PromoRedemptionStatus.RELEASED },
      })
      .exec();
    if (priorRedemptions >= capPerSubject(promo)) {
      return invalid(
        'You have already used this code the maximum number of times',
      );
    }

    return {
      valid: true,
      reason: null,
      discountCentavos: computeDiscount(promo, orderTotalCentavos),
    };
  }

  /**
   * Record a redemption, atomically.
   *
   * Re-validates from scratch rather than accepting a discount amount from
   * the caller — the whole point of server-side validation is that the
   * client's word for what a code is worth is never trusted.
   *
   * The usage-cap increment and the ledger insert happen in one transaction,
   * and the increment is itself a conditional update (only applies while
   * still under the cap) so two concurrent redemptions racing for the last
   * slot cannot both succeed.
   */
  /**
   * Who is calling this is deliberately not a parameter: a redemption is
   * attributed to the CUSTOMER (customerUid, on the input), not to whichever
   * admin or system process triggered it. The resolver records its own
   * caller to the admin audit trail separately, for a different question
   * ("which admin redeemed a code on someone's behalf") than this ledger
   * answers ("who used this code").
   */
  async redeem(input: RedeemPromoInput): Promise<PromoRedemption> {
    // Straight to REDEEMED: this is the admin's direct-grant path, and it has
    // no order whose fate could later release it.
    return this.createRedemption(input, PromoRedemptionStatus.REDEEMED);
  }

  private async createRedemption(
    input: RedeemPromoInput,
    status: PromoRedemptionStatus,
  ): Promise<PromoRedemption> {
    const promo = await this.promoModel
      .findOne({ code: input.code.trim().toUpperCase() })
      .exec();
    if (!promo) throw new NotFoundException('Promo code not found');

    const check = await this.validateAgainst(
      promo,
      input.customerUid,
      input.orderTotalCentavos,
    );
    if (!check.valid) {
      throw new BadRequestException(check.reason ?? 'Code is not valid');
    }

    const customer = await this.userModel.findById(input.customerUid).exec();

    const session = await this.connection.startSession();
    try {
      let redemption: PromoRedemptionDocument | undefined;
      await session.withTransaction(async () => {
        const capFilter =
          promo.usageCapTotal != null
            ? { _id: promo._id, redemptionCount: { $lt: promo.usageCapTotal } }
            : { _id: promo._id };

        const updated = await this.promoModel
          .findOneAndUpdate(
            capFilter,
            { $inc: { redemptionCount: 1 } },
            { session },
          )
          .exec();
        if (!updated) {
          // Lost the race for the last slot between validate() and here.
          throw new ConflictException(
            'This code was just fully redeemed — please try again',
          );
        }

        const customerName = customer
          ? `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim() ||
            customer.email
          : input.customerUid;

        const [created] = await this.redemptionModel.create(
          [
            {
              promoId: String(promo._id),
              code: promo.code,
              customerUid: input.customerUid,
              customerName,
              // `undefined`, not `null` — orderId is declared optional and
              // carries `default: null` in the schema, so letting Mongoose
              // apply the default is both type-correct and stores the same
              // value.
              orderId: input.orderId ?? undefined,
              discountAppliedCentavos: check.discountCentavos,
              status,
            },
          ],
          { session },
        );
        redemption = created;
      });
      return redemption!;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Hold this code's slot for an order that is being placed.
   *
   * Identical to `redeem` except the row lands RESERVED, so it can be handed
   * back if the order never happens. It still counts against every cap while
   * it is held — reserving cannot over-issue, it only makes the slot
   * recoverable.
   */
  async reserve(input: RedeemPromoInput): Promise<PromoRedemption> {
    return this.createRedemption(input, PromoRedemptionStatus.RESERVED);
  }

  /**
   * The order completed — the held slot is now permanently spent.
   *
   * Only RESERVED rows move. Re-running this on an already-settled order is a
   * no-op, which matters because order transitions can be retried.
   */
  async settleForOrder(
    orderId: string,
    session?: ClientSession,
  ): Promise<number> {
    const res = await this.redemptionModel
      .updateMany(
        { orderId, status: PromoRedemptionStatus.RESERVED },
        { $set: { status: PromoRedemptionStatus.REDEEMED } },
        session ? { session } : {},
      )
      .exec();
    return res.modifiedCount ?? 0;
  }

  /**
   * The order was rejected or cancelled — give the slot back.
   *
   * Decrements `redemptionCount` by exactly the number of rows this call
   * actually flipped, never by a number derived from a separate read. Two
   * concurrent releases of the same order therefore cannot double-decrement:
   * the second one flips nothing and decrements nothing.
   *
   * Only RESERVED rows are released. An admin's direct grant is REDEEMED from
   * birth and is not attached to an order lifecycle, so it is never revoked
   * by one.
   */
  async releaseForOrder(
    orderId: string,
    session?: ClientSession,
  ): Promise<number> {
    const opts = session ? { session } : {};
    const held = await this.redemptionModel
      .find({ orderId, status: PromoRedemptionStatus.RESERVED }, null, opts)
      .exec();
    if (held.length === 0) return 0;

    let released = 0;
    for (const row of held) {
      const flipped = await this.redemptionModel
        .findOneAndUpdate(
          { _id: row._id, status: PromoRedemptionStatus.RESERVED },
          {
            $set: {
              status: PromoRedemptionStatus.RELEASED,
              releasedAt: new Date(),
            },
          },
          opts,
        )
        .exec();
      if (!flipped) continue; // someone else got there first
      released += 1;
      await this.promoModel
        .findByIdAndUpdate(row.promoId, { $inc: { redemptionCount: -1 } }, opts)
        .exec();
    }
    return released;
  }

  /**
   * The platform-fee promotion this provider is entitled to on a new order, or
   * null.
   *
   * Partner incentives are not typed in at a counter. A merchant should not
   * have to remember a code while a customer waits, and an incentive nobody
   * remembers to apply is one the platform advertised and did not honour — so
   * this resolves automatically at acceptance.
   *
   * Highest-value first, so a provider who qualifies for two gets the better
   * one rather than whichever was created first.
   */
  async findPlatformFeePromoFor(
    roleId: string,
    branchId: string,
    now: Date = new Date(),
  ): Promise<PromoCodeDocument | null> {
    const candidates = await this.promoModel
      .find({
        isActive: true,
        scope: PromoScope.PLATFORM_FEE,
        targetRoleIds: roleId,
        startsAt: { $lte: now },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
      .sort({ createdAt: -1 })
      .exec();

    for (const promo of candidates) {
      if (
        promo.usageCapTotal != null &&
        promo.redemptionCount >= promo.usageCapTotal
      ) {
        continue;
      }
      const used = await this.redemptionModel
        .countDocuments({
          promoId: String(promo._id),
          subjectId: branchId,
          status: { $ne: PromoRedemptionStatus.RELEASED },
        })
        .exec();
      if (used < capPerSubject(promo)) return promo;
    }
    return null;
  }

  /**
   * Hold a slot for a BRANCH.
   *
   * The branch is the subject, so "five free orders" means five for this shop
   * — not five shared across a chain, and not five per login. The cap is
   * counted the same way and the row lands RESERVED, so an order that is
   * rejected or cancelled hands it straight back through the lifecycle that
   * already exists.
   */
  async reserveForBranch(input: {
    promoId: string;
    branchId: string;
    orderId: string;
    actorUid: string;
    actorName: string;
    discountCentavos: number;
  }): Promise<PromoRedemptionDocument | null> {
    const session = await this.connection.startSession();
    try {
      let created: PromoRedemptionDocument | undefined;
      await session.withTransaction(async () => {
        const promo = await this.promoModel
          .findById(input.promoId)
          .session(session)
          .exec();
        if (!promo) return;

        // Same atomic claim the customer path uses: the cap is enforced by the
        // conditional update, never by a read followed by a write.
        const capFilter =
          promo.usageCapTotal != null
            ? { _id: promo._id, redemptionCount: { $lt: promo.usageCapTotal } }
            : { _id: promo._id };
        const claimed = await this.promoModel
          .findOneAndUpdate(
            capFilter,
            { $inc: { redemptionCount: 1 } },
            { session },
          )
          .exec();
        if (!claimed) return; // lost the last slot

        const [row] = await this.redemptionModel.create(
          [
            {
              promoId: String(promo._id),
              code: promo.code,
              customerUid: input.actorUid,
              customerName: input.actorName,
              subjectType: RedemptionSubjectType.BRANCH,
              subjectId: input.branchId,
              orderId: input.orderId,
              discountAppliedCentavos: input.discountCentavos,
              status: PromoRedemptionStatus.RESERVED,
            },
          ],
          { session },
        );
        created = row;
      });
      return created ?? null;
    } finally {
      await session.endSession();
    }
  }

  // ── Held vouchers ────────────────────────────────────────────────────────

  /**
   * Claim a code so the holder no longer has to know it.
   *
   * Idempotent by unique index rather than by checking first: two taps, or a
   * retried request, produce ONE entitlement because a second insert cannot
   * exist. Checking-then-inserting would leave a window between the two.
   *
   * Claiming grants no money and skips no checks. The voucher still goes
   * through validate() at checkout, so caps, minimums, first-order rules and
   * the expiry all still apply at the moment it is used — a claimed voucher
   * whose promotion has since been switched off is simply not usable, and says
   * so.
   */
  async claim(
    promoId: string,
    subjectId: string,
    subjectType: RedemptionSubjectType = RedemptionSubjectType.CUSTOMER,
  ): Promise<UserVoucherDocument> {
    const promo = await this.promoModel.findById(promoId).exec();
    if (!promo) throw new NotFoundException('Promo code not found');

    // Only a live promotion can be claimed. An expired one would sit in the
    // list looking like something the person owns.
    const status = computeStatus(promo);
    if (status !== 'active') {
      throw new BadRequestException('This promotion is no longer available');
    }

    return this.userVoucherModel
      .findOneAndUpdate(
        { promoId: String(promo._id), subjectType, subjectId },
        {
          $setOnInsert: {
            promoId: String(promo._id),
            code: promo.code,
            subjectType,
            subjectId,
            claimedAt: new Date(),
          },
        },
        { upsert: true, new: true },
      )
      .exec();
  }

  /**
   * What this holder is carrying, newest first, each with a status worked out
   * from the promotion and the ledger rather than read off the row.
   */
  async vouchersFor(
    subjectId: string,
    subjectType: RedemptionSubjectType = RedemptionSubjectType.CUSTOMER,
    orderTotalCentavos?: number | null,
  ): Promise<UserVoucherView[]> {
    const held = await this.userVoucherModel
      .find({ subjectId, subjectType })
      .sort({ claimedAt: -1 })
      .exec();
    if (held.length === 0) return [];

    const promos = await this.promoModel
      .find({ _id: { $in: held.map((v) => v.promoId) } } as never)
      .exec();
    const byId = new Map(promos.map((p) => [String(p._id), p]));

    const views: UserVoucherView[] = [];
    for (const voucher of held) {
      const promo = byId.get(voucher.promoId);
      if (!promo) continue; // promotion deleted outright — nothing to show
      const used = await this.redemptionModel
        .countDocuments({
          promoId: voucher.promoId,
          ...(subjectType === RedemptionSubjectType.CUSTOMER
            ? { customerUid: subjectId }
            : { subjectId }),
          status: { $ne: PromoRedemptionStatus.RELEASED },
        })
        .exec();
      const status = voucherStatusOf(voucher, promo, used);
      // Eligibility comes from the SAME validate() the checkout runs, so the
      // picker cannot offer something that is then refused, or grey out
      // something that would have worked.
      const eligibility = await this.eligibilityFor(
        promo,
        subjectId,
        subjectType,
        status,
        orderTotalCentavos,
      );

      views.push({
        _id: String(voucher._id),
        promoId: voucher.promoId,
        code: voucher.code,
        description: promo.description,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
        maxDiscountCentavos: promo.maxDiscountCentavos ?? null,
        minOrderValueCentavos: promo.minOrderValueCentavos ?? null,
        expiresAt: promo.expiresAt ?? null,
        claimedAt: voucher.claimedAt,
        usesRemaining: Math.max(0, capPerSubject(promo) - used),
        status,
        ...eligibility,
      });
    }
    return views;
  }

  /**
   * Whether this voucher can be used on the order in question, and why not.
   *
   * With no order to ask about there is nothing to be eligible FOR, so this
   * answers the simpler question — is it live — and leaves the amount unknown.
   */
  private async eligibilityFor(
    promo: PromoCodeDocument,
    subjectId: string,
    subjectType: RedemptionSubjectType,
    status: UserVoucherStatus,
    orderTotalCentavos?: number | null,
  ): Promise<{
    usable: boolean;
    unusableReason: string | null;
    discountPreviewCentavos: number | null;
  }> {
    const no = (reason: string) => ({
      usable: false,
      unusableReason: reason,
      discountPreviewCentavos: null,
    });

    if (status !== UserVoucherStatus.AVAILABLE) {
      // The status already says why in the list; repeating it as a reason
      // would double the message on a row that shows both.
      return no(VOUCHER_STATUS_REASON[status]);
    }

    // A fee incentive belongs to a provider and can never come off a
    // customer's order. It should not be claimable in the first place, so this
    // is a backstop rather than an expected path — but a wrong answer here
    // would be a customer seeing a partner's incentive offered to them.
    if (
      scopeOf(promo) === PromoScope.PLATFORM_FEE &&
      subjectType === RedemptionSubjectType.CUSTOMER
    ) {
      return no('This offer applies to provider fees, not to your order');
    }

    if (orderTotalCentavos == null) {
      return {
        usable: true,
        unusableReason: null,
        discountPreviewCentavos: null,
      };
    }

    const check = await this.validateAgainst(
      promo,
      subjectId,
      orderTotalCentavos,
    );
    if (!check.valid) return no(check.reason ?? 'Not valid for this order');
    return {
      usable: true,
      unusableReason: null,
      discountPreviewCentavos: check.discountCentavos,
    };
  }

  /** Take a voucher back. The row stays so "it vanished" has an answer. */
  async revokeVoucher(id: string): Promise<UserVoucherDocument> {
    const updated = await this.userVoucherModel
      .findByIdAndUpdate(id, { $set: { revokedAt: new Date() } }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Voucher not found');
    return updated;
  }

  async usageSummary(id: string): Promise<PromoUsageSummary> {
    const promo = await this.findOne(id);

    const [redemptions, byDayRaw, overCapRaw] = await Promise.all([
      this.redemptionModel
        .find({ promoId: id })
        .sort({ createdAt: -1 })
        .limit(50)
        .exec(),
      this.redemptionModel
        .aggregate<{ _id: string; count: number }>([
          { $match: { promoId: id } },
          {
            $group: {
              _id: {
                $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: 14 },
        ])
        .exec(),
      this.redemptionModel
        .aggregate<{
          _id: string;
          count: number;
          customerName: string;
        }>([
          { $match: { promoId: id } },
          {
            $group: {
              _id: '$customerUid',
              count: { $sum: 1 },
              customerName: { $last: '$customerName' },
            },
          },
          { $match: { count: { $gt: promo.usageCapPerCustomer } } },
        ])
        .exec(),
    ]);

    const [totalAgg] = await this.redemptionModel
      .aggregate<{ count: number; sum: number; customers: number }>([
        { $match: { promoId: id } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            sum: { $sum: '$discountAppliedCentavos' },
            customers: { $addToSet: '$customerUid' },
          },
        },
        {
          $project: {
            count: 1,
            sum: 1,
            customers: { $size: '$customers' },
          },
        },
      ])
      .exec();

    const overCapCustomers: PromoRedeemer[] = overCapRaw.map((r) => ({
      customerUid: r._id,
      customerName: r.customerName,
      redemptionCount: r.count,
    }));

    return {
      totalRedemptions: totalAgg?.count ?? 0,
      uniqueCustomers: totalAgg?.customers ?? 0,
      totalDiscountCentavos: totalAgg?.sum ?? 0,
      byDay: byDayRaw.map((d) => ({ date: d._id, count: d.count })),
      overCapCustomers,
      recentRedemptions: redemptions,
    };
  }
}

function invalid(reason: string): PromoValidation {
  return { valid: false, reason, discountCentavos: 0 };
}

function computeDiscount(
  promo: Pick<
    PromoCode,
    'discountType' | 'discountValue' | 'maxDiscountCentavos'
  >,
  orderTotalCentavos: number,
): number {
  if (promo.discountType === PromoDiscountType.FLAT) {
    return Math.min(promo.discountValue, orderTotalCentavos);
  }
  const raw = Math.floor((orderTotalCentavos * promo.discountValue) / 100);
  const capped =
    promo.maxDiscountCentavos != null
      ? Math.min(raw, promo.maxDiscountCentavos)
      : raw;
  return Math.min(capped, orderTotalCentavos);
}

/**
 * The status a promo code would show on the list page. Mirrors the same
 * vocabulary FEE_RULE_STATUS already uses on the frontend (active / scheduled
 * / expired / inactive) plus one promo-specific state, `exhausted`, which a
 * fee rule has no equivalent of.
 */
export function computeStatus(
  promo: Pick<
    PromoCode,
    'isActive' | 'startsAt' | 'expiresAt' | 'redemptionCount' | 'usageCapTotal'
  >,
): 'active' | 'scheduled' | 'expired' | 'exhausted' | 'disabled' {
  if (!promo.isActive) return 'disabled';
  const now = new Date();
  if (now < promo.startsAt) return 'scheduled';
  if (promo.expiresAt && now > promo.expiresAt) return 'expired';
  if (
    promo.usageCapTotal != null &&
    promo.redemptionCount >= promo.usageCapTotal
  ) {
    return 'exhausted';
  }
  return 'active';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Not every scope/method pair means anything.
 *
 * Refused rather than quietly coerced, because each of these reads as a
 * sensible thing to want and does something else:
 *
 *  - ORDER_TOTAL + WAIVE would be a free order of unbounded value. If that is
 *    genuinely intended it is PERCENTAGE 100 with a maximum, which forces the
 *    person creating it to name a ceiling.
 *  - PLATFORM_FEE + FLAT/PERCENTAGE is a partial fee discount. Coherent, and
 *    deliberately not enabled yet: it needs a rule for what happens when the
 *    fee is repriced after weighing, and Phase 1 does not answer that.
 *  - firstOrderOnly on a PLATFORM_FEE code is customer vocabulary applied to a
 *    provider. It would silently never match.
 */
export function assertScopeAndMethodAgree(input: {
  scope?: PromoScope | null;
  discountType: PromoDiscountType;
  firstOrderOnly?: boolean;
}): void {
  const scope = input.scope ?? PromoScope.ORDER_TOTAL;

  if (scope === PromoScope.ORDER_TOTAL) {
    if (input.discountType === PromoDiscountType.WAIVE) {
      throw new BadRequestException(
        'To give an order away, use a 100% discount with a maximum amount — a waiver has no ceiling.',
      );
    }
    return;
  }

  if (input.discountType !== PromoDiscountType.WAIVE) {
    throw new BadRequestException(
      'Platform-fee promotions can only waive the fee in full for now.',
    );
  }
  if (input.firstOrderOnly) {
    throw new BadRequestException(
      '"First order only" applies to a customer\'s first order and has no meaning for a platform-fee promotion.',
    );
  }
}

/**
 * A held voucher's status, worked out from the promotion and the ledger.
 *
 * Order matters: revoked beats everything (an admin's decision is not
 * overridden by the promotion still being live), then the promotion's own
 * state, then whether this holder has any uses left. A voucher on a promotion
 * that has expired reads EXPIRED rather than USED even if it was also fully
 * used — the more useful thing to tell someone is why they cannot use it now.
 */
export function voucherStatusOf(
  voucher: Pick<UserVoucher, 'revokedAt'>,
  promo: Pick<
    PromoCode,
    | 'isActive'
    | 'startsAt'
    | 'expiresAt'
    | 'redemptionCount'
    | 'usageCapTotal'
    | 'usageCapPerSubject'
    | 'usageCapPerCustomer'
  >,
  usedBySubject: number,
): UserVoucherStatus {
  if (voucher.revokedAt) return UserVoucherStatus.REVOKED;
  if (computeStatus(promo) !== 'active') return UserVoucherStatus.EXPIRED;
  if (usedBySubject >= capPerSubject(promo)) return UserVoucherStatus.USED;
  return UserVoucherStatus.AVAILABLE;
}

/** Why a non-available voucher cannot be used, in the holder's words. */
const VOUCHER_STATUS_REASON: Record<UserVoucherStatus, string> = {
  [UserVoucherStatus.AVAILABLE]: '',
  [UserVoucherStatus.USED]: "You've already used this voucher",
  [UserVoucherStatus.EXPIRED]: 'This offer has ended',
  [UserVoucherStatus.REVOKED]: 'This voucher is no longer available',
};
