import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { SiteContentService } from './site-content.service';
import { FaqEntry } from './schemas/faq-entry.schema';
import { ServiceArea } from './schemas/service-area.schema';
import { SiteAnnouncement } from './schemas/site-announcement.schema';
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
 * Admin CRUD for the marketing website's editable content. Admin-only — this
 * is public-facing copy for the whole platform, the same class of decision
 * as a broadcast, not a support lookup. The site itself reads the SAME data
 * through site-content.controller.ts's unauthenticated REST endpoints — see
 * that file for why REST rather than GraphQL for the public side.
 */
@Resolver()
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class SiteContentResolver {
  constructor(
    private readonly siteContent: SiteContentService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  // ── FAQ ────────────────────────────────────────────────────────────────

  @Query(() => [FaqEntry], { name: 'siteFaqEntries' })
  async siteFaqEntries(): Promise<FaqEntry[]> {
    return this.siteContent.listFaqEntries();
  }

  @Mutation(() => FaqEntry)
  async createSiteFaqEntry(
    @Args('input') input: CreateFaqEntryInput,
    @CurrentUser() actor: User,
  ): Promise<FaqEntry> {
    const entry = await this.siteContent.createFaqEntry(input);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: String(entry._id),
      targetLabel: `FAQ: ${entry.question}`,
    });
    return entry;
  }

  @Mutation(() => FaqEntry)
  async updateSiteFaqEntry(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateFaqEntryInput,
    @CurrentUser() actor: User,
  ): Promise<FaqEntry> {
    const entry = await this.siteContent.updateFaqEntry(id, input);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: id,
      targetLabel: `FAQ: ${entry.question}`,
    });
    return entry;
  }

  @Mutation(() => Boolean)
  async deleteSiteFaqEntry(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() actor: User,
  ): Promise<boolean> {
    const result = await this.siteContent.deleteFaqEntry(id);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: id,
      targetLabel: 'FAQ entry deleted',
    });
    return result;
  }

  // ── Service areas ────────────────────────────────────────────────────────

  @Query(() => [ServiceArea], { name: 'siteServiceAreas' })
  async siteServiceAreas(): Promise<ServiceArea[]> {
    return this.siteContent.listServiceAreas();
  }

  @Mutation(() => ServiceArea)
  async createSiteServiceArea(
    @Args('input') input: CreateServiceAreaInput,
    @CurrentUser() actor: User,
  ): Promise<ServiceArea> {
    const area = await this.siteContent.createServiceArea(input);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: String(area._id),
      targetLabel: `Service area: ${area.name}`,
    });
    return area;
  }

  @Mutation(() => ServiceArea)
  async updateSiteServiceArea(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateServiceAreaInput,
    @CurrentUser() actor: User,
  ): Promise<ServiceArea> {
    const area = await this.siteContent.updateServiceArea(id, input);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: id,
      targetLabel: `Service area: ${area.name}`,
    });
    return area;
  }

  @Mutation(() => Boolean)
  async deleteSiteServiceArea(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() actor: User,
  ): Promise<boolean> {
    const result = await this.siteContent.deleteServiceArea(id);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: id,
      targetLabel: 'Service area deleted',
    });
    return result;
  }

  // ── Announcements (promo banners) ───────────────────────────────────────

  @Query(() => [SiteAnnouncement], { name: 'siteAnnouncements' })
  async siteAnnouncements(): Promise<SiteAnnouncement[]> {
    return this.siteContent.listAnnouncements();
  }

  @Mutation(() => SiteAnnouncement)
  async createSiteAnnouncement(
    @Args('input') input: CreateSiteAnnouncementInput,
    @CurrentUser() actor: User,
  ): Promise<SiteAnnouncement> {
    const announcement = await this.siteContent.createAnnouncement(input);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: String(announcement._id),
      targetLabel: `Announcement: ${announcement.title}`,
    });
    return announcement;
  }

  @Mutation(() => SiteAnnouncement)
  async updateSiteAnnouncement(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateSiteAnnouncementInput,
    @CurrentUser() actor: User,
  ): Promise<SiteAnnouncement> {
    const announcement = await this.siteContent.updateAnnouncement(id, input);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: id,
      targetLabel: `Announcement: ${announcement.title}`,
    });
    return announcement;
  }

  @Mutation(() => Boolean)
  async deleteSiteAnnouncement(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() actor: User,
  ): Promise<boolean> {
    const result = await this.siteContent.deleteAnnouncement(id);
    await this.adminAudit.record({
      action: AdminAuditAction.SITE_CONTENT_UPDATED,
      actor,
      targetType: AdminAuditTargetType.SITE_CONTENT,
      targetId: id,
      targetLabel: 'Announcement deleted',
    });
    return result;
  }
}
