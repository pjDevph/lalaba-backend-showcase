import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StaffService } from './staff.service';
import { StaffResolver } from './staff.resolver';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import { FirebaseModule } from '../firebase/firebase.module';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Permission.name, schema: PermissionSchema },
    ]),
    FirebaseModule,
    UsersModule,
    DevicesModule,
  ],
  providers: [StaffService, StaffResolver],
})
export class StaffModule {}
