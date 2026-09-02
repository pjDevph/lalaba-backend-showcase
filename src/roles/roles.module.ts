import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RolesService } from './roles.service';
import { RolesResolver } from './roles.resolver';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Role.name, schema: RoleSchema },
      // Read-only here: delete() must know whether anyone still holds the role
      // before removing it.
      { name: User.name, schema: UserSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [RolesService, RolesResolver],
  exports: [RolesService],
})
export class RolesModule {}
