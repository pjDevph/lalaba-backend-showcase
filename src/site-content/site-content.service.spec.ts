import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { NotFoundException } from '@nestjs/common';

import { SiteContentService } from './site-content.service';
import {
  FaqEntry,
  FaqEntrySchema,
  FaqCategory,
} from './schemas/faq-entry.schema';
import { ServiceArea, ServiceAreaSchema } from './schemas/service-area.schema';
import {
  SiteAnnouncement,
  SiteAnnouncementSchema,
  SiteAnnouncementAudience,
} from './schemas/site-announcement.schema';

describe('SiteContentService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: SiteContentService;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: FaqEntry.name, schema: FaqEntrySchema },
          { name: ServiceArea.name, schema: ServiceAreaSchema },
          { name: SiteAnnouncement.name, schema: SiteAnnouncementSchema },
        ]),
      ],
      providers: [SiteContentService],
    }).compile();

    service = module.get(SiteContentService);
    connection = module.get(getConnectionToken());
  }, 60_000);

  afterEach(async () => {
    await connection.models[FaqEntry.name].deleteMany({});
    await connection.models[ServiceArea.name].deleteMany({});
    await connection.models[SiteAnnouncement.name].deleteMany({});
  });

  afterAll(async () => {
    await module.close();
    await replSet.stop();
  });

  describe('FAQ', () => {
    it('lists only published entries for the public read, sorted by category then order', async () => {
      await service.createFaqEntry({
        category: FaqCategory.PARTNERS,
        question: 'B',
        answer: 'b',
        order: 1,
      });
      await service.createFaqEntry({
        category: FaqCategory.GENERAL_AND_CUSTOMER,
        question: 'A',
        answer: 'a',
        order: 2,
      });
      const draft = await service.createFaqEntry({
        category: FaqCategory.GENERAL_AND_CUSTOMER,
        question: 'Draft',
        answer: 'unpublished',
        order: 0,
      });
      await service.updateFaqEntry(String(draft._id), { isPublished: false });

      const published = await service.listPublishedFaqEntries();
      expect(published).toHaveLength(2);
      expect(published[0].question).toBe('A');
      expect(published[1].question).toBe('B');

      const all = await service.listFaqEntries();
      expect(all).toHaveLength(3);
    });

    it('throws NotFoundException updating or deleting a missing entry', async () => {
      const missingId = '507f1f77bcf86cd799439011';
      await expect(
        service.updateFaqEntry(missingId, { question: 'x' }),
      ).rejects.toThrow(NotFoundException);
      await expect(service.deleteFaqEntry(missingId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes an entry', async () => {
      const entry = await service.createFaqEntry({
        category: FaqCategory.PARTNERS,
        question: 'Q',
        answer: 'A',
      });
      await service.deleteFaqEntry(String(entry._id));
      expect(await service.listFaqEntries()).toHaveLength(0);
    });
  });

  describe('Service areas', () => {
    it('only returns published areas on the public read', async () => {
      await service.createServiceArea({ name: 'Quezon City', order: 1 });
      const hidden = await service.createServiceArea({
        name: 'Draft City',
        order: 2,
      });
      await service.updateServiceArea(String(hidden._id), {
        isPublished: false,
      });

      const published = await service.listPublishedServiceAreas();
      expect(published.map((a) => a.name)).toEqual(['Quezon City']);
    });
  });

  describe('Announcements', () => {
    it('defaults audience to ALL and only returns published rows publicly', async () => {
      const announcement = await service.createAnnouncement({
        eyebrow: 'New',
        title: 'Launch promo',
        description: 'Get 50% off',
        ctaText: 'Book now',
        ctaUrl: 'https://lalaba.example/book',
      });
      expect(announcement.audience).toBe(SiteAnnouncementAudience.ALL);

      await service.updateAnnouncement(String(announcement._id), {
        isPublished: false,
      });
      expect(await service.listPublishedAnnouncements()).toHaveLength(0);
      expect(await service.listAnnouncements()).toHaveLength(1);
    });
  });
});
