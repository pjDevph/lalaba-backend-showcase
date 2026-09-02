import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  BookingPolicy,
  BookingPolicyDocument,
  BookingPolicyStatus,
  POLICY_SEED,
} from './schemas/booking-policy.schema';
import {
  BookingMilestone,
  BookingMilestoneDocument,
} from './schemas/booking-milestone.schema';
import {
  BookingCampaign,
  BookingCampaignDocument,
  CampaignScope,
} from './schemas/booking-campaign.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  ProviderType,
} from '../online-orders/schemas/order-status.enum';
import {
  WasherProfile,
  WasherProfileDocument,
  WasherStatus,
  VerificationStatus,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  EffectiveEntitlement,
  NEW_PROVIDER_STATS,
  ProviderStats,
  nextMilestone,
  resolveEntitlement,
  resolveMilestone,
} from './entitlement.util';
import {
  PublishBookingPolicyInput,
  UpsertBookingMilestoneInput,
  UpsertBookingCampaignInput,
} from './dto/booking-policy.input';
import {
  CampaignImpact,
  MilestoneProgress,
  PolicySimulation,
} from './models/booking-policy.models';
import { WEEK_ORDER } from '../booking-availability/availability-resolution.util';
import { parseHHMM, phDayKey } from '../common/utils/ph-time.util';

/**
 * Drops keys whose value is `undefined`.
 *
 * A GraphQL input object is a class instance with every declared optional
 * property present, so `{...stored, ...input}` silently overwrites stored
 * values with undefined for every field the caller omitted. Only meaningful
 * for PARTIAL merges — an explicit `null` is preserved, because null is a real
 * value elsewhere in this module ("inherit").
 */
function definedOnly<T extends object>(
  value: T | undefined | null,
): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Orders that count as delivered work for milestone purposes. */
const COMPLETED_STATUSES = [OrderStatus.COMPLETED];

/** Cancellations attributable to the provider. */
const PROVIDER_ABANDONED_STATUSES = [
  OrderStatus.REJECTED_BY_PROVIDER,
  OrderStatus.CANCELLED,
];

@Injectable()
export class BookingPolicyService {
  constructor(
    @InjectModel(BookingPolicy.name)
    private readonly policyModel: Model<BookingPolicyDocument>,
    @InjectModel(BookingMilestone.name)
    private readonly milestoneModel: Model<BookingMilestoneDocument>,
    @InjectModel(BookingCampaign.name)
    private readonly campaignModel: Model<BookingCampaignDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
  ) {}

  // ── Policy ───────────────────────────────────────────────────────────────

  /**
   * The live policy, seeding one on first read so the admin page always has a
   * version to edit and every provider has defaults to be evaluated against.
   */
  async current(): Promise<BookingPolicyDocument> {
    const live = await this.policyModel
      .findOne({ status: BookingPolicyStatus.LIVE })
      .exec();
    if (live) return live;

    return this.policyModel.create({
      version: 1,
      status: BookingPolicyStatus.LIVE,
      enabled: true,
      universalDays: this.seedWeek(),
      changeNote: 'Initial platform booking policy',
      publishedAt: new Date(),
    } as never);
  }

  private seedWeek(): Record<string, unknown> {
    return WEEK_ORDER.reduce<Record<string, unknown>>(
      (acc, key) => ({
        ...acc,
        [key]: {
          isOpen: true,
          windows: [
            { start: POLICY_SEED.windowOpen, end: POLICY_SEED.windowClose },
          ],
        },
      }),
      {},
    );
  }

  async history(limit = 20): Promise<BookingPolicyDocument[]> {
    return this.policyModel.find().sort({ version: -1 }).limit(limit).exec();
  }

  /**
   * Publishing writes a NEW version and archives the previous one. Nothing is
   * written to any provider — that is the entire point of the module — so this
   * is O(1) whether the platform has ten providers or ten million.
   */
  async publish(
    input: PublishBookingPolicyInput,
    actorUid: string,
  ): Promise<BookingPolicyDocument> {
    const live = await this.current();

    // Two things have to be true for a partial publish to preserve what the
    // caller did not send, and neither is automatic:
    //
    //   1. .toObject() — a Mongoose subdocument spreads to its INTERNAL
    //      properties, not its fields, so `{ ...live.defaults }` is not the
    //      stored defaults at all.
    //   2. definedOnly() — a GraphQL input object carries every declared
    //      optional field as an explicit `undefined` key, so spreading the
    //      input over the stored values would blank every field the admin left
    //      alone. The page saves one section at a time, so this is the normal
    //      case, not an edge case.
    const current = live.toObject();

    const merged = {
      enabled: input.enabled ?? current.enabled,
      defaults: { ...current.defaults, ...definedOnly(input.defaults) },
      universalDays: input.universalDays ?? current.universalDays,
      safetyLimits: {
        ...current.safetyLimits,
        ...definedOnly(input.safetyLimits),
      },
    };

    this.assertPolicyCoherent(merged);

    // Archive first: the partial unique index permits only one LIVE row, so
    // inserting before archiving would be rejected by the database.
    await this.policyModel
      .updateOne(
        { _id: live._id },
        { $set: { status: BookingPolicyStatus.ARCHIVED } },
      )
      .exec();

    try {
      return await this.policyModel.create({
        version: live.version + 1,
        status: BookingPolicyStatus.LIVE,
        ...merged,
        changeNote: input.changeNote ?? null,
        publishedBy: actorUid,
        publishedAt: new Date(),
      } as never);
    } catch (err) {
      // Never leave the platform with no live policy.
      await this.policyModel
        .updateOne(
          { _id: live._id },
          { $set: { status: BookingPolicyStatus.LIVE } },
        )
        .exec();
      throw err;
    }
  }

  private assertPolicyCoherent(merged: {
    defaults: Record<string, unknown>;
    safetyLimits: Record<string, unknown>;
    universalDays: unknown;
  }): void {
    const d = merged.defaults as {
      dailyCapacity: number;
      advanceBookingDays: number;
      sameDayCutoffTime: string;
    };
    const s = merged.safetyLimits as {
      dailyCapacity: number;
      advanceBookingDays: number;
    };

    // A default above the ceiling is not a harmless inconsistency: every
    // provider would be silently clamped, and the number on the page would
    // describe nobody.
    if (d.dailyCapacity > s.dailyCapacity) {
      throw new BadRequestException(
        `The base daily capacity (${d.dailyCapacity}) cannot exceed the platform maximum (${s.dailyCapacity}).`,
      );
    }
    if (d.advanceBookingDays > s.advanceBookingDays) {
      throw new BadRequestException(
        `The advance window (${d.advanceBookingDays} days) cannot exceed the platform maximum (${s.advanceBookingDays} days).`,
      );
    }
    if (Number.isNaN(parseHHMM(d.sameDayCutoffTime))) {
      throw new BadRequestException(
        'The same-day cutoff must be a valid time.',
      );
    }

    const week = merged.universalDays as Record<
      string,
      { isOpen: boolean; windows: { start: string; end: string }[] }
    >;
    for (const key of WEEK_ORDER) {
      const day = week?.[key];
      if (!day?.isOpen) continue;
      if (!day.windows || day.windows.length === 0) {
        throw new BadRequestException(
          `${key[0].toUpperCase()}${key.slice(1)} is open but has no booking window.`,
        );
      }
      for (const w of day.windows) {
        if (parseHHMM(w.end) <= parseHHMM(w.start)) {
          throw new BadRequestException(
            `${key[0].toUpperCase()}${key.slice(1)}: the closing time must be after the opening time.`,
          );
        }
      }
    }
  }

  // ── Milestones ───────────────────────────────────────────────────────────

  async listMilestones(): Promise<BookingMilestoneDocument[]> {
    return this.milestoneModel.find().sort({ rank: 1 }).exec();
  }

  async upsertMilestone(
    input: UpsertBookingMilestoneInput,
    actorUid: string,
  ): Promise<BookingMilestoneDocument> {
    if (input.isDefault) {
      // Exactly one floor. Two defaults would make a new provider's
      // entitlement depend on document order.
      await this.milestoneModel
        .updateMany({ key: { $ne: input.key } }, { $set: { isDefault: false } })
        .exec();
    }

    return this.milestoneModel
      .findOneAndUpdate(
        { key: input.key },
        { $set: { ...input, updatedBy: actorUid } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  async removeMilestone(key: string): Promise<boolean> {
    const milestone = await this.milestoneModel.findOne({ key }).exec();
    if (!milestone) return false;
    if (milestone.isDefault) {
      throw new BadRequestException(
        'The default milestone cannot be deleted — every provider needs a floor. Make another milestone the default first.',
      );
    }
    // A campaign targeting a deleted milestone would silently apply to nobody.
    const targeting = await this.campaignModel
      .countDocuments({ 'targeting.milestoneKeys': key })
      .exec();
    if (targeting > 0) {
      throw new BadRequestException(
        `${milestone.name} is targeted by ${targeting} campaign(s). Update those first.`,
      );
    }
    await this.milestoneModel.deleteOne({ key }).exec();
    return true;
  }

  // ── Campaigns ────────────────────────────────────────────────────────────

  async listCampaigns(): Promise<BookingCampaignDocument[]> {
    return this.campaignModel.find().sort({ startDate: -1 }).exec();
  }

  async upsertCampaign(
    input: UpsertBookingCampaignInput,
    actorUid: string,
  ): Promise<BookingCampaignDocument> {
    if (input.endDate < input.startDate) {
      throw new BadRequestException(
        'The campaign cannot end before it starts.',
      );
    }
    if (
      input.targeting?.scope === CampaignScope.MILESTONE &&
      (input.targeting.milestoneKeys ?? []).length === 0
    ) {
      throw new BadRequestException('Pick at least one milestone to target.');
    }
    if (
      input.targeting?.scope === CampaignScope.PROVIDER_TYPE &&
      !input.targeting.providerType
    ) {
      throw new BadRequestException('Pick which provider type to target.');
    }

    if (input.id) {
      const updated = await this.campaignModel
        .findByIdAndUpdate(input.id, { $set: input }, { new: true })
        .exec();
      if (!updated) throw new NotFoundException('Campaign not found');
      return updated;
    }

    return this.campaignModel.create({
      ...input,
      createdBy: actorUid,
    } as never);
  }

  async removeCampaign(id: string): Promise<boolean> {
    const res = await this.campaignModel.deleteOne({ _id: id } as never).exec();
    return res.deletedCount > 0;
  }

  /**
   * How many providers a campaign would reach — a COUNT, never a fetch-and-
   * update. This is the number the review screen shows before publishing, and
   * it exists to make the "no provider records are modified" claim legible.
   */
  async campaignImpact(input: {
    scope: CampaignScope;
    providerType?: ProviderType | null;
    milestoneKeys?: string[];
  }): Promise<CampaignImpact> {
    const [washerTotal, branchTotal] = await Promise.all([
      this.washerModel.countDocuments({ status: WasherStatus.ACTIVE }).exec(),
      this.branchModel.countDocuments({ isActive: true }).exec(),
    ]);

    if (input.scope === CampaignScope.PROVIDER_TYPE) {
      const isWasher = input.providerType === ProviderType.WASHER;
      return {
        washers: isWasher ? washerTotal : 0,
        merchants: isWasher ? 0 : branchTotal,
        total: isWasher ? washerTotal : branchTotal,
        isEstimate: false,
      };
    }

    if (input.scope === CampaignScope.MILESTONE) {
      // Milestone membership is derived, not stored, so an exact count would
      // mean evaluating every provider — the very scan this design avoids.
      // The admin gets an explicit estimate flag instead of a false precision.
      return {
        washers: washerTotal,
        merchants: 0,
        total: washerTotal,
        isEstimate: true,
      };
    }

    return {
      washers: washerTotal,
      merchants: branchTotal,
      total: washerTotal + branchTotal,
      isEstimate: false,
    };
  }

  // ── Provider statistics ──────────────────────────────────────────────────

  /**
   * The facts a milestone is evaluated against, for ONE provider. Two counts
   * and a cached rating — cheap enough to run per booking, and never a
   * platform-wide scan.
   */
  async statsFor(
    branchId: string,
    providerType: ProviderType,
  ): Promise<ProviderStats> {
    if (providerType !== ProviderType.WASHER) return NEW_PROVIDER_STATS;

    const washer = await this.washerModel.findOne({ branchId }).exec();
    if (!washer) return NEW_PROVIDER_STATS;

    const [completed, abandoned, total] = await Promise.all([
      this.orderModel
        .countDocuments({
          'provider.branchId': branchId,
          status: { $in: COMPLETED_STATUSES },
        })
        .exec(),
      this.orderModel
        .countDocuments({
          'provider.branchId': branchId,
          status: { $in: PROVIDER_ABANDONED_STATUSES },
        })
        .exec(),
      this.orderModel.countDocuments({ 'provider.branchId': branchId }).exec(),
    ]);

    return {
      completedOrders: completed,
      rating:
        washer.ratingAggregate?.count > 0
          ? washer.ratingAggregate.overallAverage
          : null,
      // Below a handful of orders the percentage is noise — 1 cancellation out
      // of 2 is not a 50% cancellation rate in any useful sense.
      cancellationRatePercent:
        total >= 5 ? Math.round((abandoned / total) * 1000) / 10 : null,
      isVerified: washer.verificationStatus === VerificationStatus.APPROVED,
      inGoodStanding: washer.status === WasherStatus.ACTIVE,
    };
  }

  // ── Effective entitlement ────────────────────────────────────────────────

  /**
   * What this provider is entitled to on this date. The single entry point for
   * the booking gate, the partner app and the simulator.
   */
  async entitlementFor(
    branchId: string,
    providerType: ProviderType,
    date?: string,
  ): Promise<EffectiveEntitlement> {
    const on = date ?? phDayKey();
    const [policy, milestones, campaigns, stats] = await Promise.all([
      this.current(),
      this.listMilestones(),
      this.liveCampaignsOn(on),
      this.statsFor(branchId, providerType),
    ]);

    return resolveEntitlement({
      policy,
      milestones,
      campaigns,
      stats,
      providerType,
      date: on,
    });
  }

  /** Campaigns whose window covers a date. Filtered in the query, not in JS. */
  private async liveCampaignsOn(
    date: string,
  ): Promise<BookingCampaignDocument[]> {
    return this.campaignModel
      .find({
        isEnabled: true,
        startDate: { $lte: date },
        endDate: { $gte: date },
      })
      .exec();
  }

  /** §4 — the partner app's "next milestone" panel. */
  async progressFor(
    branchId: string,
    providerType: ProviderType,
  ): Promise<MilestoneProgress | null> {
    if (providerType !== ProviderType.WASHER) return null;

    const [milestones, stats] = await Promise.all([
      this.listMilestones(),
      this.statsFor(branchId, providerType),
    ]);

    const current = resolveMilestone(milestones, stats);
    const next = nextMilestone(milestones, current);

    const target = next?.eligibility?.minCompletedOrders ?? null;
    return {
      currentKey: current?.key ?? null,
      currentName: current?.name ?? null,
      currentDailyCapacity: current?.entitlements.dailyCapacity ?? null,
      completedOrders: stats.completedOrders,
      rating: stats.rating,
      nextKey: next?.key ?? null,
      nextName: next?.name ?? null,
      nextDailyCapacity: next?.entitlements.dailyCapacity ?? null,
      nextAdvanceBookingDays: next?.entitlements.advanceBookingDays ?? null,
      ordersRequired: target,
      ordersRemaining:
        target == null ? null : Math.max(0, target - stats.completedOrders),
      unmetRequirements: next ? this.describeUnmet(next, stats) : [],
    };
  }

  /** Plain-language list of what a provider still has to do. */
  private describeUnmet(
    milestone: BookingMilestone,
    stats: ProviderStats,
  ): string[] {
    const e = milestone.eligibility ?? {};
    const unmet: string[] = [];

    if (
      e.minCompletedOrders != null &&
      stats.completedOrders < e.minCompletedOrders
    ) {
      unmet.push(
        `${e.minCompletedOrders - stats.completedOrders} more completed orders`,
      );
    }
    if (
      e.minRating != null &&
      (stats.rating == null || stats.rating < e.minRating)
    ) {
      unmet.push(`A rating of ${e.minRating.toFixed(1)} or higher`);
    }
    if (
      e.maxCancellationRatePercent != null &&
      stats.cancellationRatePercent != null &&
      stats.cancellationRatePercent > e.maxCancellationRatePercent
    ) {
      unmet.push(
        `A cancellation rate at or under ${e.maxCancellationRatePercent}%`,
      );
    }
    if (e.requireVerified && !stats.isVerified) {
      unmet.push('A verified account');
    }
    if (e.requireGoodStanding && !stats.inGoodStanding) {
      unmet.push('An account in good standing');
    }
    return unmet;
  }

  // ── Simulator (§11) ──────────────────────────────────────────────────────

  /**
   * Runs the real resolver against hypothetical stats, so an admin can see what
   * a rule change does before publishing it. Deliberately calls the same
   * `resolveEntitlement` the booking gate calls — a simulator with its own
   * arithmetic would eventually disagree with the system it models.
   */
  async simulate(args: {
    providerType: ProviderType;
    milestoneKey?: string | null;
    date?: string;
  }): Promise<PolicySimulation> {
    const date = args.date ?? phDayKey();
    const [policy, milestones, campaigns] = await Promise.all([
      this.current(),
      this.listMilestones(),
      this.liveCampaignsOn(date),
    ]);

    // Synthesise the stats of a provider sitting exactly on the chosen
    // milestone, rather than requiring a real provider to exist at that tier.
    const target = args.milestoneKey
      ? milestones.find((m) => m.key === args.milestoneKey)
      : undefined;
    const stats: ProviderStats = target
      ? {
          completedOrders: target.eligibility?.minCompletedOrders ?? 0,
          rating: target.eligibility?.minRating ?? 5,
          cancellationRatePercent: 0,
          isVerified: true,
          inGoodStanding: true,
        }
      : NEW_PROVIDER_STATS;

    const entitlement = resolveEntitlement({
      policy,
      milestones,
      campaigns,
      stats,
      providerType: args.providerType,
      date,
    });

    return { date, entitlement };
  }
}
