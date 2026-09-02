import { Global, Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DevicesService } from './devices.service';
import { DevicesResolver } from './devices.resolver';
import { Device, DeviceSchema } from './schemas/device.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';

// Global so DevicesService is injectable everywhere — GqlAuthGuard depends on it
// and is re-instantiated inside every guarded module (see UsersModule note).
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Device.name, schema: DeviceSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: User.name, schema: UserSchema },
    ]),
    forwardRef(() => UsersModule),
    // Devices <-> Notifications are mutually dependent (notify-on-register vs the
    // guard's device check), so both sides use forwardRef.
    forwardRef(() => NotificationsModule),
  ],
  providers: [DevicesService, DevicesResolver],
  exports: [DevicesService],
})
export class DevicesModule {}
