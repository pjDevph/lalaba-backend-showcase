import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActivityLogsService } from './activity-logs.service';
import { ActivityLogsResolver } from './activity-logs.resolver';
import { ActivityLog, ActivityLogSchema } from './schemas/activity-log.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ActivityLog.name, schema: ActivityLogSchema },
      { name: Permission.name, schema: PermissionSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [ActivityLogsService, ActivityLogsResolver, PermissionsGuard],
  exports: [ActivityLogsService],
})
export class ActivityLogsModule {}
