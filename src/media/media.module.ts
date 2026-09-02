import { Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { MediaResolver } from './media.resolver';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [UsersModule, DevicesModule, StorageModule],
  providers: [MediaService, MediaResolver],
  exports: [MediaService],
})
export class MediaModule {}
