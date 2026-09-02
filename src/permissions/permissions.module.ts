import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PermissionsService } from './permissions.service';
import { PermissionsResolver } from './permissions.resolver';
import { Permission, PermissionSchema } from './schemas/permission.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Permission.name, schema: PermissionSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [PermissionsService, PermissionsResolver],
  exports: [PermissionsService],
})
export class PermissionsModule {}
