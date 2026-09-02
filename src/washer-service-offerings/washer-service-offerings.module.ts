import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WasherServiceOfferingsService } from './washer-service-offerings.service';
import { WasherServiceOfferingsResolver } from './washer-service-offerings.resolver';
import {
  WasherServiceOffering,
  WasherServiceOfferingSchema,
} from './schemas/washer-service-offering.schema';
import {
  WasherServiceTemplate,
  WasherServiceTemplateSchema,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { WasherModule } from '../washer/washer.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WasherServiceOffering.name, schema: WasherServiceOfferingSchema },
      { name: WasherServiceTemplate.name, schema: WasherServiceTemplateSchema },
    ]),
    WasherModule,
  ],
  providers: [WasherServiceOfferingsService, WasherServiceOfferingsResolver],
  exports: [WasherServiceOfferingsService],
})
export class WasherServiceOfferingsModule {}
