import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SiteContentService } from './site-content.service';
import { SiteContentResolver } from './site-content.resolver';
import { SiteContentController } from './site-content.controller';
import { FaqEntry, FaqEntrySchema } from './schemas/faq-entry.schema';
import { ServiceArea, ServiceAreaSchema } from './schemas/service-area.schema';
import {
  SiteAnnouncement,
  SiteAnnouncementSchema,
} from './schemas/site-announcement.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FaqEntry.name, schema: FaqEntrySchema },
      { name: ServiceArea.name, schema: ServiceAreaSchema },
      { name: SiteAnnouncement.name, schema: SiteAnnouncementSchema },
    ]),
  ],
  controllers: [SiteContentController],
  providers: [SiteContentService, SiteContentResolver],
})
export class SiteContentModule {}
