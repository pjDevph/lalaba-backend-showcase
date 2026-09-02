import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WasherServiceTemplatesService } from './washer-service-templates.service';
import { WasherServiceTemplatesResolver } from './washer-service-templates.resolver';
import {
  WasherServiceTemplate,
  WasherServiceTemplateSchema,
} from './schemas/washer-service-template.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WasherServiceTemplate.name, schema: WasherServiceTemplateSchema },
    ]),
  ],
  providers: [WasherServiceTemplatesService, WasherServiceTemplatesResolver],
  exports: [WasherServiceTemplatesService],
})
export class WasherServiceTemplatesModule {}
