import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { FaqEntry, FaqEntryDocument } from './schemas/faq-entry.schema';
import {
  ServiceArea,
  ServiceAreaDocument,
} from './schemas/service-area.schema';
import {
  SiteAnnouncement,
  SiteAnnouncementDocument,
} from './schemas/site-announcement.schema';
import {
  CreateFaqEntryInput,
  UpdateFaqEntryInput,
} from './dto/faq-entry.input';
import {
  CreateServiceAreaInput,
  UpdateServiceAreaInput,
} from './dto/service-area.input';
import {
  CreateSiteAnnouncementInput,
  UpdateSiteAnnouncementInput,
} from './dto/site-announcement.input';

/**
 * Backs both the admin CRUD (via the resolver, auth required) and the public
 * read endpoints the marketing site fetches from (via the controller, no
 * auth — see site-content.controller.ts for why REST rather than GraphQL).
 * One service, two front doors, same data.
 */
@Injectable()
export class SiteContentService {
  constructor(
    @InjectModel(FaqEntry.name)
    private readonly faqModel: Model<FaqEntryDocument>,
    @InjectModel(ServiceArea.name)
    private readonly serviceAreaModel: Model<ServiceAreaDocument>,
    @InjectModel(SiteAnnouncement.name)
    private readonly announcementModel: Model<SiteAnnouncementDocument>,
  ) {}

  // ── FAQ ────────────────────────────────────────────────────────────────

  async listFaqEntries(): Promise<FaqEntryDocument[]> {
    return this.faqModel.find().sort({ category: 1, order: 1 }).exec();
  }

  async listPublishedFaqEntries(): Promise<FaqEntryDocument[]> {
    return this.faqModel
      .find({ isPublished: true })
      .sort({ category: 1, order: 1 })
      .exec();
  }

  async createFaqEntry(input: CreateFaqEntryInput): Promise<FaqEntryDocument> {
    return this.faqModel.create({ ...input, order: input.order ?? 0 });
  }

  async updateFaqEntry(
    id: string,
    input: UpdateFaqEntryInput,
  ): Promise<FaqEntryDocument> {
    const entry = await this.faqModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    if (!entry) throw new NotFoundException('FAQ entry not found');
    return entry;
  }

  async deleteFaqEntry(id: string): Promise<boolean> {
    const result = await this.faqModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('FAQ entry not found');
    return true;
  }

  // ── Service areas ────────────────────────────────────────────────────────

  async listServiceAreas(): Promise<ServiceAreaDocument[]> {
    return this.serviceAreaModel.find().sort({ order: 1 }).exec();
  }

  async listPublishedServiceAreas(): Promise<ServiceAreaDocument[]> {
    return this.serviceAreaModel
      .find({ isPublished: true })
      .sort({ order: 1 })
      .exec();
  }

  async createServiceArea(
    input: CreateServiceAreaInput,
  ): Promise<ServiceAreaDocument> {
    return this.serviceAreaModel.create({ ...input, order: input.order ?? 0 });
  }

  async updateServiceArea(
    id: string,
    input: UpdateServiceAreaInput,
  ): Promise<ServiceAreaDocument> {
    const area = await this.serviceAreaModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    if (!area) throw new NotFoundException('Service area not found');
    return area;
  }

  async deleteServiceArea(id: string): Promise<boolean> {
    const result = await this.serviceAreaModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Service area not found');
    return true;
  }

  // ── Announcements (promo banners) ───────────────────────────────────────

  async listAnnouncements(): Promise<SiteAnnouncementDocument[]> {
    return this.announcementModel.find().sort({ order: 1 }).exec();
  }

  async listPublishedAnnouncements(): Promise<SiteAnnouncementDocument[]> {
    return this.announcementModel
      .find({ isPublished: true })
      .sort({ order: 1 })
      .exec();
  }

  async createAnnouncement(
    input: CreateSiteAnnouncementInput,
  ): Promise<SiteAnnouncementDocument> {
    return this.announcementModel.create({ ...input, order: input.order ?? 0 });
  }

  async updateAnnouncement(
    id: string,
    input: UpdateSiteAnnouncementInput,
  ): Promise<SiteAnnouncementDocument> {
    const announcement = await this.announcementModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    if (!announcement) throw new NotFoundException('Announcement not found');
    return announcement;
  }

  async deleteAnnouncement(id: string): Promise<boolean> {
    const result = await this.announcementModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Announcement not found');
    return true;
  }
}
