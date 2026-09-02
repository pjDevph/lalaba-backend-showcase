import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PresenceService } from './presence.service';
import { PresenceResolver } from './presence.resolver';
import { Presence, PresenceSchema } from './schemas/presence.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Presence.name, schema: PresenceSchema },
    ]),
  ],
  providers: [PresenceService, PresenceResolver],
})
export class PresenceModule {}
