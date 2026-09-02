import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';
import { Rating, RatingDocument } from './schemas/rating.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  ProviderType,
} from '../online-orders/schemas/order-status.enum';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { User } from '../users/schemas/user.schema';
import { SubmitRatingInput } from './dto/submit-rating.input';
import { UpdateRatingInput } from './dto/update-rating.input';
import { RatingFilterInput } from './dto/rating-filter.input';
import { PaginatedRatings } from './models/paginated-ratings.model';

const RATING_WINDOW_DAYS = 30;
const EDIT_WINDOW_HOURS = 48;
const DIMENSIONS = [
  'quality',
  'speed',
  'valueForMoney',
  'delivery',
  'communication',
] as const;

@Injectable()
export class RatingsService {
  constructor(
    @InjectModel(Rating.name)
    private readonly ratingModel: Model<RatingDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerProfileModel: Model<WasherProfileDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private average(scores: Record<string, number>): number {
    const values = DIMENSIONS.map((d) => scores[d]);
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private async aggregateModelFor(
    providerType: ProviderType,
    branchId: string,
  ) {
    if (providerType === ProviderType.WASHER) {
      const profile = await this.washerProfileModel
        .findOne({ branchId })
        .exec();
      if (!profile) throw new NotFoundException('Washer profile not found');
      return {
        model: this.washerProfileModel,
        filter: { _id: profile._id },
        doc: profile,
      };
    }
    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch) throw new NotFoundException('Branch not found');
    return {
      model: this.branchModel,
      filter: { _id: branch._id },
      doc: branch,
    };
  }

  private async applyAggregateDelta(
    providerType: ProviderType,
    branchId: string,
    deltas: {
      countDelta: number;
      overallDelta: number;
      dimensionDeltas: Record<string, number>;
    },
    session: ClientSession,
  ): Promise<void> {
    const { model, filter, doc } = await this.aggregateModelFor(
      providerType,
      branchId,
    );
    const agg = doc.ratingAggregate ?? {
      count: 0,
      overallAverage: 0,
      qualityAverage: 0,
      speedAverage: 0,
      valueForMoneyAverage: 0,
      deliveryAverage: 0,
      communicationAverage: 0,
    };
    const oldCount = agg.count;
    const newCount = oldCount + deltas.countDelta;

    const recompute = (oldAverage: number, delta: number): number => {
      const oldSum = oldAverage * oldCount;
      const newSum = oldSum + delta;
      return newCount > 0 ? newSum / newCount : 0;
    };

    const update = {
      'ratingAggregate.count': newCount,
      'ratingAggregate.overallAverage': recompute(
        agg.overallAverage,
        deltas.overallDelta,
      ),
      'ratingAggregate.qualityAverage': recompute(
        agg.qualityAverage,
        deltas.dimensionDeltas.quality,
      ),
      'ratingAggregate.speedAverage': recompute(
        agg.speedAverage,
        deltas.dimensionDeltas.speed,
      ),
      'ratingAggregate.valueForMoneyAverage': recompute(
        agg.valueForMoneyAverage,
        deltas.dimensionDeltas.valueForMoney,
      ),
      'ratingAggregate.deliveryAverage': recompute(
        agg.deliveryAverage,
        deltas.dimensionDeltas.delivery,
      ),
      'ratingAggregate.communicationAverage': recompute(
        agg.communicationAverage,
        deltas.dimensionDeltas.communication,
      ),
    };
    await (model as Model<any>)
      .updateOne(filter, { $set: update }, { session })
      .exec();
  }

  async submitRating(
    orderId: string,
    customer: User,
    input: SubmitRatingInput,
  ): Promise<Rating> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');
    if (order.customer.uid !== customer._id) {
      throw new ForbiddenException('Not your order');
    }
    if (order.status !== OrderStatus.COMPLETED || !order.completedAt) {
      throw new BadRequestException('Only completed orders can be rated');
    }
    const daysSinceCompletion =
      (Date.now() - order.completedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCompletion > RATING_WINDOW_DAYS) {
      throw new BadRequestException(
        'The rating window for this order has closed',
      );
    }
    const existing = await this.ratingModel.findOne({ orderId }).exec();
    if (existing)
      throw new BadRequestException('This order has already been rated');

    const scores = {
      quality: input.quality,
      speed: input.speed,
      valueForMoney: input.valueForMoney,
      delivery: input.delivery,
      communication: input.communication,
    };
    const overallScore = this.average(scores);
    const now = new Date();

    const session = await this.connection.startSession();
    let saved: RatingDocument;
    try {
      await session.withTransaction(async () => {
        const [created] = await this.ratingModel.create(
          [
            {
              orderId,
              customerUid: customer._id,
              providerType: order.provider.providerType,
              branchId: order.provider.branchId,
              scores,
              overallScore,
              comment: input.comment,
              editableUntil: new Date(
                now.getTime() + EDIT_WINDOW_HOURS * 60 * 60 * 1000,
              ),
            },
          ],
          { session },
        );
        saved = created;
        await this.applyAggregateDelta(
          order.provider.providerType,
          order.provider.branchId,
          {
            countDelta: 1,
            overallDelta: overallScore,
            dimensionDeltas: scores,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return saved!;
  }

  async updateRating(
    orderId: string,
    customer: User,
    input: UpdateRatingInput,
  ): Promise<Rating> {
    const rating = await this.ratingModel.findOne({ orderId }).exec();
    if (!rating) throw new NotFoundException('Rating not found');
    if (rating.customerUid !== customer._id)
      throw new ForbiddenException('Not your rating');
    if (new Date() > rating.editableUntil) {
      throw new BadRequestException(
        'The edit window for this rating has closed',
      );
    }

    const newScores = {
      quality: input.quality,
      speed: input.speed,
      valueForMoney: input.valueForMoney,
      delivery: input.delivery,
      communication: input.communication,
    };
    const newOverall = this.average(newScores);
    const dimensionDeltas: Record<string, number> = {};
    for (const d of DIMENSIONS)
      dimensionDeltas[d] = newScores[d] - rating.scores[d];
    const overallDelta = newOverall - rating.overallScore;

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        rating.scores = newScores;
        rating.overallScore = newOverall;
        rating.comment = input.comment;
        await rating.save({ session });
        await this.applyAggregateDelta(
          rating.providerType,
          rating.branchId,
          { countDelta: 0, overallDelta, dimensionDeltas },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return rating;
  }

  async reportRating(ratingId: string, reason: string): Promise<Rating> {
    const rating = await this.ratingModel
      .findByIdAndUpdate(
        ratingId,
        { $set: { isReported: true, reportReason: reason } },
        { new: true },
      )
      .exec();
    if (!rating) throw new NotFoundException('Rating not found');
    return rating;
  }

  // Admin/Support takedown after review (§ratings — reactive moderation).
  async moderateTakedown(ratingId: string, reason: string): Promise<Rating> {
    const rating = await this.ratingModel.findById(ratingId).exec();
    if (!rating) throw new NotFoundException('Rating not found');
    if (rating.isRemoved) return rating; // idempotent

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        rating.isRemoved = true;
        rating.removalReason = reason;
        await rating.save({ session });
        const dimensionDeltas: Record<string, number> = {};
        for (const d of DIMENSIONS) dimensionDeltas[d] = -rating.scores[d];
        await this.applyAggregateDelta(
          rating.providerType,
          rating.branchId,
          {
            countDelta: -1,
            overallDelta: -rating.overallScore,
            dimensionDeltas,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return rating;
  }

  /**
   * Put a removed review back.
   *
   * The counterpart takedown never had. Without it a moderation mistake is
   * permanent, which makes moderators slower and more cautious than the job
   * needs — the review is hidden, not deleted, so putting it back is exactly
   * as reversible as taking it down should have been.
   *
   * Re-applies the aggregate delta that the takedown subtracted, in the same
   * transaction as the flag flip. A restore that forgot this would leave the
   * provider's rating permanently short by one review.
   */
  async restoreRating(ratingId: string, reason: string): Promise<Rating> {
    const rating = await this.ratingModel.findById(ratingId).exec();
    if (!rating) throw new NotFoundException('Rating not found');
    if (!rating.isRemoved) return rating; // idempotent, like the takedown

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        rating.isRemoved = false;
        // The removal reason is kept: why it was taken down is part of the
        // record even once it is back, and clearing it would erase the only
        // trace on the document itself.
        rating.restoredReason = reason;
        await rating.save({ session });
        const dimensionDeltas: Record<string, number> = {};
        for (const d of DIMENSIONS) dimensionDeltas[d] = rating.scores[d];
        await this.applyAggregateDelta(
          rating.providerType,
          rating.branchId,
          {
            countDelta: 1,
            overallDelta: rating.overallScore,
            dimensionDeltas,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return rating;
  }

  /**
   * Mark a report as looked at, without removing the review.
   *
   * The queue's other exit. Without this, a review that was reported and found
   * perfectly fine stays flagged forever and the queue only ever grows — which
   * ends with moderators ignoring it, the exact failure a queue exists to
   * prevent.
   */
  async dismissReport(ratingId: string, reason: string): Promise<Rating> {
    const rating = await this.ratingModel
      .findByIdAndUpdate(
        ratingId,
        {
          $set: {
            isReported: false,
            reportDismissedReason: reason,
            reportDismissedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!rating) throw new NotFoundException('Rating not found');
    return rating;
  }

  /**
   * Platform-wide moderation queue.
   *
   * Reported-but-live reviews first: those are the ones where the platform has
   * been asked to act and has not. Removed reviews are included so a takedown
   * can be reviewed and reversed, but they are not what the queue is FOR.
   */
  async moderationQueue(
    filter: {
      reported?: boolean;
      removed?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginatedRatings> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const clauses: Record<string, unknown>[] = [];
    if (filter.reported) clauses.push({ isReported: true });
    if (filter.removed) clauses.push({ isRemoved: true });
    // Neither asked for = everything that has ever needed a decision.
    const query =
      clauses.length > 0
        ? { $or: clauses }
        : { $or: [{ isReported: true }, { isRemoved: true }] };

    const [data, total] = await Promise.all([
      this.ratingModel
        .find(query)
        // Reported-and-live at the top, then newest — a removed review is a
        // decision already made, and it must not bury one still waiting.
        .sort({ isRemoved: 1, createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.ratingModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit, offset };
  }

  async respondToReview(
    ratingId: string,
    provider: User,
    text: string,
  ): Promise<Rating> {
    const rating = await this.ratingModel.findById(ratingId).exec();
    if (!rating) throw new NotFoundException('Rating not found');
    const branch = await this.branchModel.findById(rating.branchId).exec();
    if (!branch || branch.uid !== provider._id) {
      throw new ForbiddenException('You do not manage this shop');
    }
    rating.providerResponse = { text, respondedAt: new Date() };
    await rating.save();
    return rating;
  }

  async shopRatings(
    branchId: string,
    filter: RatingFilterInput = {},
  ): Promise<PaginatedRatings> {
    const { limit = 20, offset = 0 } = filter;
    const query = { branchId, isRemoved: false };
    const [data, total] = await Promise.all([
      this.ratingModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.ratingModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit, offset };
  }

  async myRatingForOrder(
    orderId: string,
    customer: User,
  ): Promise<Rating | null> {
    return this.ratingModel
      .findOne({ orderId, customerUid: customer._id })
      .exec();
  }
}
