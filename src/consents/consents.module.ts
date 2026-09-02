import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConsentsService } from './consents.service';
import { ConsentsResolver } from './consents.resolver';
import { Consent, ConsentSchema } from './schemas/consent.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Consent.name, schema: ConsentSchema }]),
  ],
  providers: [ConsentsService, ConsentsResolver],
  exports: [ConsentsService],
})
export class ConsentsModule {}
