import { Module, forwardRef } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsService } from './notifications.service';
import { NotificationsResolver } from './notifications.resolver';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastsResolver } from './broadcasts.resolver';
import { Broadcast, BroadcastSchema } from './schemas/broadcast.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { NotificationsFeedService } from './notifications-feed.service';
import { NotificationsFeedResolver } from './notifications-feed.resolver';
import {
  Notification,
  NotificationSchema,
} from './schemas/notification.schema';
import {
  NotificationRead,
  NotificationReadSchema,
} from './schemas/notification-read.schema';
import {
  NotificationReadCursor,
  NotificationReadCursorSchema,
} from './schemas/notification-read-cursor.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';

@Module({
  // FirebaseModule + UsersModule cover NotificationsService's deps and let Nest
  // auto-instantiate GqlAuthGuard; DevicesModule supplies the guard's staff
  // device check. DevicesModule also depends back on NotificationsService
  // (notify-on-register), so this side uses forwardRef to break the cycle.
  imports: [
    FirebaseModule,
    // UsersModule is part of the Users→Devices→Notifications→Users cycle, so it
    // must also be forwardRef'd or it resolves to undefined at load time.
    forwardRef(() => UsersModule),
    forwardRef(() => DevicesModule),
    // Broadcasts resolve their own audience straight from users/roles rather
    // than through UsersService — that module is inside the forwardRef cycle
    // above, and a broadcast only needs to read.
    MongooseModule.forFeature([
      { name: Broadcast.name, schema: BroadcastSchema },
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: NotificationRead.name, schema: NotificationReadSchema },
      {
        name: NotificationReadCursor.name,
        schema: NotificationReadCursorSchema,
      },
      // Branch and Permission are registered as MODELS rather than imported as
      // modules for exactly the reason given above: the feed only reads them
      // (branch ownership, permission names), and importing BranchesModule or
      // PermissionsModule here would add edges into the Users→Devices→
      // Notifications→Users cycle that this module works hard to keep narrow.
      { name: Branch.name, schema: BranchSchema },
      { name: Permission.name, schema: PermissionSchema },
    ]),
  ],
  providers: [
    NotificationsService,
    NotificationsResolver,
    NotificationsFeedService,
    NotificationsFeedResolver,
    BroadcastsService,
    BroadcastsResolver,
  ],
  exports: [NotificationsService, NotificationsFeedService],
})
export class NotificationsModule {}
