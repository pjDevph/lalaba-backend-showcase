import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { NotFoundException } from '@nestjs/common';

import { RatingsService } from './ratings.service';
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
import { ProviderType } from '../online-orders/schemas/order-status.enum';

/**
 * Moderation only. The rest of RatingsService (submission, editing, provider
 * responses) predates this file and is exercised elsewhere; these tests cover
 * the takedown/restore/dismiss triangle, where the risk is a provider's public
 * score silently drifting.
 */
describe('RatingsService — moderation (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: RatingsService;

  let branchId: string;

  const makeBranch = async () => {
    const branch = await connection.models[Branch.name].create({
      uid: new Types.ObjectId().toString(),
      branchName: 'Test Laundromat',
      branchPhoneNumber: '09171234567',
      branchAddress: {
        regionName: 'NCR',
        provinceName: 'Metro Manila',
        cityMunicipalityName: 'Makati',
        barangayName: 'Bel-Air',
        streetAddress: '1 Test St',
      },
      branchMapLocation: { latitude: 14.55, longitude: 121.02 },
      operatingHours: {},
      verificationStatus: 'PENDING',
    });
    return String(branch._id);
  };

  const makeRating = async (
    overrides: {
      score?: number;
      isReported?: boolean;
      isRemoved?: boolean;
      comment?: string;
    } = {},
  ) => {
    const score = overrides.score ?? 4;
    const doc = await connection.models[Rating.name].create({
      orderId: new Types.ObjectId().toString(),
      customerUid: new Types.ObjectId().toString(),
      providerType: ProviderType.MERCHANT,
      branchId,
      scores: {
        quality: score,
        speed: score,
        valueForMoney: score,
        delivery: score,
        communication: score,
      },
      overallScore: score,
      comment: overrides.comment ?? 'Fine service.',
      editableUntil: new Date(Date.now() + 48 * 60 * 60 * 1000),
      isReported: overrides.isReported ?? false,
      isRemoved: overrides.isRemoved ?? false,
    });
    return String(doc._id);
  };

  const branchAggregate = async () => {
    const branch = await connection.models[Branch.name]
      .findById(branchId)
      .exec();
    // The aggregate stores AVERAGES, not sums — applyAggregateDelta
    // recomputes each average from the old one and the count.
    return (
      branch as unknown as {
        ratingAggregate?: { count?: number; overallAverage?: number };
      }
    ).ratingAggregate;
  };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: Rating.name, schema: RatingSchema },
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
        ]),
      ],
      providers: [RatingsService],
    }).compile();

    service = module.get(RatingsService);
    connection = module.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [Rating.name, Branch.name, WasherProfile.name]) {
      await connection.models[name].deleteMany({});
    }
    branchId = await makeBranch();
  });

  describe('takedown and restore', () => {
    it('hides a review and subtracts it from the provider aggregate', async () => {
      const ratingId = await makeRating({ score: 5 });
      // Seed the aggregate as if the review had been counted on submission.
      await connection.models[Branch.name].updateOne(
        { _id: branchId },
        {
          $set: {
            'ratingAggregate.count': 1,
            'ratingAggregate.overallAverage': 5,
          },
        },
      );

      const removed = await service.moderateTakedown(ratingId, 'ABUSIVE');

      expect(removed.isRemoved).toBe(true);
      expect(removed.removalReason).toBe('ABUSIVE');
      const agg = await branchAggregate();
      expect(agg?.count).toBe(0);
      expect(agg?.overallAverage).toBe(0);
    });

    // The whole reason restore exists: a takedown that cannot be reversed
    // makes moderators slower and more cautious than the job needs.
    it('puts a removed review back and re-adds it to the aggregate', async () => {
      const ratingId = await makeRating({ score: 5 });
      await connection.models[Branch.name].updateOne(
        { _id: branchId },
        {
          $set: {
            'ratingAggregate.count': 1,
            'ratingAggregate.overallAverage': 5,
          },
        },
      );
      await service.moderateTakedown(ratingId, 'ABUSIVE');

      const restored = await service.restoreRating(ratingId, 'MISTAKE');

      expect(restored.isRemoved).toBe(false);
      expect(restored.restoredReason).toBe('MISTAKE');
      const agg = await branchAggregate();
      expect(agg?.count).toBe(1);
      expect(agg?.overallAverage).toBe(5);
    });

    // Why it was taken down is part of the record even once it is back.
    it('keeps the removal reason after a restore', async () => {
      const ratingId = await makeRating();
      await service.moderateTakedown(ratingId, 'ABUSIVE');

      const restored = await service.restoreRating(ratingId, 'MISTAKE');

      expect(restored.removalReason).toBe('ABUSIVE');
    });

    // A double-click must not subtract the review twice and leave the
    // provider's score permanently wrong.
    it('is idempotent in both directions', async () => {
      const ratingId = await makeRating({ score: 4 });
      await connection.models[Branch.name].updateOne(
        { _id: branchId },
        {
          $set: {
            'ratingAggregate.count': 1,
            'ratingAggregate.overallAverage': 4,
          },
        },
      );

      await service.moderateTakedown(ratingId, 'ABUSIVE');
      await service.moderateTakedown(ratingId, 'ABUSIVE');
      expect((await branchAggregate())?.count).toBe(0);

      await service.restoreRating(ratingId, 'MISTAKE');
      await service.restoreRating(ratingId, 'MISTAKE');
      expect((await branchAggregate())?.count).toBe(1);
    });

    it('restoring a review that was never removed changes nothing', async () => {
      const ratingId = await makeRating();
      await connection.models[Branch.name].updateOne(
        { _id: branchId },
        {
          $set: {
            'ratingAggregate.count': 1,
            'ratingAggregate.overallAverage': 4,
          },
        },
      );

      await service.restoreRating(ratingId, 'MISTAKE');

      expect((await branchAggregate())?.count).toBe(1);
    });

    it('throws for a review that does not exist', async () => {
      await expect(
        service.restoreRating(new Types.ObjectId().toString(), 'x'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('dismissing a report', () => {
    // The queue's other exit. Without it a review that was reported and found
    // fine stays flagged forever and the queue only grows.
    it('clears the flag and records that someone looked', async () => {
      const ratingId = await makeRating({ isReported: true });

      const dismissed = await service.dismissReport(ratingId, 'NOT_ABUSIVE');

      expect(dismissed.isReported).toBe(false);
      expect(dismissed.reportDismissedReason).toBe('NOT_ABUSIVE');
      expect(dismissed.reportDismissedAt).toBeInstanceOf(Date);
      // The review itself is untouched — dismissing is not a takedown.
      expect(dismissed.isRemoved).toBe(false);
    });

    it('takes the review out of the queue', async () => {
      const ratingId = await makeRating({ isReported: true });
      expect((await service.moderationQueue()).total).toBe(1);

      await service.dismissReport(ratingId, 'NOT_ABUSIVE');

      expect((await service.moderationQueue()).total).toBe(0);
    });
  });

  describe('moderation queue', () => {
    it('includes reported and removed reviews, and nothing else', async () => {
      await makeRating({ isReported: true });
      await makeRating({ isRemoved: true });
      await makeRating(); // untouched — must not appear

      expect((await service.moderationQueue()).total).toBe(2);
    });

    // A decision already made must not bury one still waiting.
    it('puts reviews still awaiting a decision above ones already handled', async () => {
      await makeRating({ isRemoved: true, comment: 'already handled' });
      await makeRating({ isReported: true, comment: 'still waiting' });

      const { data } = await service.moderationQueue();

      expect(data[0].comment).toBe('still waiting');
    });

    it('filters to just reported or just removed', async () => {
      await makeRating({ isReported: true });
      await makeRating({ isRemoved: true });

      expect((await service.moderationQueue({ reported: true })).total).toBe(1);
      expect((await service.moderationQueue({ removed: true })).total).toBe(1);
    });

    it('reports a total for the whole queue, not the page', async () => {
      for (let i = 0; i < 5; i++) await makeRating({ isReported: true });

      const page = await service.moderationQueue({ limit: 2 });

      expect(page.data).toHaveLength(2);
      expect(page.total).toBe(5);
    });
  });
});
