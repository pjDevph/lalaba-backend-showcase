import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CampaignsService } from './campaigns.service';
import {
  CampaignsAdminResolver,
  CampaignsDeliveryResolver,
} from './campaigns.resolver';
import { Campaign, CampaignSchema } from './schemas/campaign.schema';
import {
  CampaignImpression,
  CampaignImpressionSchema,
} from './schemas/campaign-impression.schema';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { PromotionsModule } from '../promotions/promotions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: CampaignImpression.name, schema: CampaignImpressionSchema },
    ]),
    AdminAuditModule,
    PromotionsModule,
  ],
  providers: [
    CampaignsService,
    CampaignsAdminResolver,
    CampaignsDeliveryResolver,
  ],
  exports: [CampaignsService],
})
export class CampaignsModule {}
