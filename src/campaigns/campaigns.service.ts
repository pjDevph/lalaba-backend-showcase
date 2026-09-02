import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Campaign,
  CampaignActionType,
  CampaignDocument,
  CampaignStatus,
} from './schemas/campaign.schema';
import {
  CampaignImpression,
  CampaignImpressionDocument,
} from './schemas/campaign-impression.schema';
import {
  APP_OPEN_FLOOR_MINUTES,
  MissingSessionIdError,
  impressionExpiryFor,
  periodKeyFor,
} from './campaign-frequency.util';
import { CampaignFrequency } from './schemas/campaign.schema';
import { CreateCampaignInput } from './dto/create-campaign.input';
import { UpdateCampaignInput } from './dto/update-campaign.input';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

/** Mongo's duplicate-key error. Here it is the frequency rule firing, not a
 *  fault: someone already saw this campaign in this window. */
const DUPLICATE_KEY = 11000;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(CampaignImpression.name)
    private readonly impressionModel: Model<CampaignImpressionDocument>,
  ) {}

  // ── Admin ────────────────────────────────────────────────────────────────

  async create(
    input: CreateCampaignInput,
    actorUid: string,
    actorName: string,
  ): Promise<CampaignDocument> {
    this.assertActionIsCoherent(input);
    return this.campaignModel.create({
      ...input,
      createdByUid: actorUid,
      createdByName: actorName,
    });
  }

  async update(
    id: string,
    input: UpdateCampaignInput,
  ): Promise<CampaignDocument> {
    const existing = await this.findOne(id);
    this.assertActionIsCoherent({
      actionType: input.actionType ?? existing.actionType,
      promoId: input.promoId ?? existing.promoId,
      deepLink: input.deepLink ?? existing.deepLink,
    });
    const updated = await this.campaignModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Campaign not found');
    return updated;
  }

  async findOne(id: string): Promise<CampaignDocument> {
    const found = await this.campaignModel.findById(id).exec();
    if (!found) throw new NotFoundException('Campaign not found');
    return found;
  }

  async findAll(): Promise<CampaignDocument[]> {
    return this.campaignModel
      .find()
      .sort({ priority: -1, createdAt: -1 })
      .exec();
  }

  /**
   * An action must carry the thing it acts on.
   *
   * A PROMO campaign with no promo is a button that does nothing, and the
   * person who notices is a customer who tapped it expecting a discount.
   */
  private assertActionIsCoherent(input: {
    actionType?: CampaignActionType | null;
    promoId?: string | null;
    deepLink?: string | null;
  }): void {
    if (input.actionType === CampaignActionType.PROMO && !input.promoId) {
      throw new BadRequestException('Pick the promo this campaign advertises');
    }
    if (input.actionType === CampaignActionType.DEEP_LINK && !input.deepLink) {
      throw new BadRequestException('Pick the screen this campaign opens');
    }
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  /**
   * The one campaign this account should see right now, or null.
   *
   * The caller supplies no role and no audience: both are derived from the
   * authenticated identity here. An app that could name its own audience could
   * show itself campaigns meant for someone else, which for a partner-only
   * incentive is a disclosure, not just a wrong picture.
   *
   * Returns at most ONE. Several campaigns can be eligible at once and the
   * highest priority wins; the rest simply wait for the next window rather
   * than stacking into a queue of modals.
   */
  async nextFor(
    user: User,
    sessionId?: string | null,
    now: Date = new Date(),
  ): Promise<CampaignDocument | null> {
    const roleId = (user.role as unknown as Role | undefined)?.roleId;
    if (!roleId) return null;

    const eligible = await this.campaignModel
      .find({
        status: CampaignStatus.ACTIVE,
        targetRoleIds: roleId,
        startsAt: { $lte: now },
        $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
      })
      .sort({ priority: -1, createdAt: -1 })
      .exec();

    for (const campaign of eligible) {
      const shown = await this.tryRecordImpression(
        campaign,
        user._id,
        roleId,
        sessionId,
        now,
      );
      if (shown) return campaign;
    }
    return null;
  }

  /**
   * Claim this account's showing of this campaign, or report that it is not
   * due. The write IS the check — a unique index on
   * (campaign, account, period) means two concurrent requests produce one
   * impression and one duplicate-key error, never two popups.
   */
  /**
   * The promo a campaign advertises, if this account may claim it.
   *
   * The campaign IS the gate. Without it, a claim mutation taking a promo id
   * would let anyone claim any live code by guessing an id — including one
   * meant to be typed in by a specific customer, or a partner incentive. Going
   * through the campaign means a code can only be claimed by someone the
   * campaign was actually shown to the audience of.
   */
  async claimablePromoId(campaignId: string, user: User): Promise<string> {
    const roleId = (user.role as unknown as Role | undefined)?.roleId;
    const campaign = await this.campaignModel.findById(campaignId).exec();

    // One message for every failure. "Wrong audience" and "no such campaign"
    // are the same answer to someone who should not be reading this campaign,
    // and distinguishing them would confirm that an id exists.
    const refuse = () =>
      new NotFoundException('This offer is no longer available');

    if (!campaign || !roleId) throw refuse();
    if (campaign.status !== CampaignStatus.ACTIVE) throw refuse();
    if (!campaign.targetRoleIds.includes(roleId)) throw refuse();
    const now = new Date();
    if (campaign.startsAt > now) throw refuse();
    if (campaign.endsAt && campaign.endsAt <= now) throw refuse();
    if (campaign.actionType !== CampaignActionType.PROMO || !campaign.promoId) {
      throw refuse();
    }
    return campaign.promoId;
  }

  private async tryRecordImpression(
    campaign: CampaignDocument,
    uid: string,
    roleId: string,
    sessionId: string | null | undefined,
    now: Date,
  ): Promise<boolean> {
    let periodKey: string;
    try {
      periodKey = periodKeyFor(campaign.frequency, now, sessionId);
    } catch (err) {
      if (err instanceof MissingSessionIdError) {
        // An EVERY_LOGIN campaign asked about without a session id. Skip it
        // rather than failing the request: the app still deserves an answer,
        // and the next campaign down may well be showable.
        return false;
      }
      throw err;
    }

    // The floor, checked before the insert because the bucket key alone cannot
    // express it: two opens either side of a bucket boundary can be a minute
    // apart and would otherwise both qualify.
    if (
      campaign.frequency === CampaignFrequency.EVERY_APP_OPEN &&
      (await this.shownWithinFloor(String(campaign._id), uid, now))
    ) {
      return false;
    }

    try {
      await this.impressionModel.create({
        campaignId: String(campaign._id),
        uid,
        roleId,
        periodKey,
        shownAt: now,
        expiresAt: impressionExpiryFor(campaign.frequency, now),
      });
      return true;
    } catch (err) {
      if ((err as { code?: number })?.code === DUPLICATE_KEY) return false;
      throw err;
    }
  }

  private async shownWithinFloor(
    campaignId: string,
    uid: string,
    now: Date,
  ): Promise<boolean> {
    const since = new Date(now.getTime() - APP_OPEN_FLOOR_MINUTES * 60_000);
    const recent = await this.impressionModel
      .exists({ campaignId, uid, shownAt: { $gte: since } })
      .exec();
    return recent != null;
  }

  /**
   * Record that the person acted on, or dismissed, a campaign they were shown.
   *
   * Scoped to the caller's own impression: an account cannot stamp someone
   * else's. Silently does nothing if there is no impression to stamp, because
   * the alternative — an error — would make a dismissal that arrived late fail
   * visibly for no benefit to anyone.
   */
  async recordInteraction(
    campaignId: string,
    uid: string,
    kind: 'CLICKED' | 'DISMISSED',
    now: Date = new Date(),
  ): Promise<boolean> {
    const field = kind === 'CLICKED' ? 'clickedAt' : 'dismissedAt';
    // findOneAndUpdate, not updateOne — only the latter has no `sort`, and the
    // stamp belongs on the MOST RECENT showing rather than on whichever row
    // the index happens to reach first.
    const stamped = await this.impressionModel
      .findOneAndUpdate(
        { campaignId, uid, [field]: null },
        { $set: { [field]: now } },
        { sort: { shownAt: -1 } },
      )
      .exec();
    return stamped != null;
  }
}
