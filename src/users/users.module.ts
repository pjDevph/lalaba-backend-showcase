import { Global, Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './users.service';
import { UsersResolver } from './users.resolver';
import { User, UserSchema } from './schemas/user.schema';
import { Role, RoleSchema } from './schemas/role.schema';
import { Branch, BranchSchema } from 'src/branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from 'src/washer/schemas/washer-profile.schema';
import { FirebaseModule } from 'src/firebase/firebase.module';
import { GqlAuthGuard } from 'src/auth/guards/gql-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { DevicesModule } from 'src/devices/devices.module';
import { ConsentsModule } from 'src/consents/consents.module';
import { WalletsModule } from 'src/wallets/wallets.module';
import { RoleLoader } from './role.loader';

// Global so UsersService is injectable everywhere — in particular it lets Nest
// instantiate GqlAuthGuard (which depends on UsersService) inside any module that
// uses @UseGuards(GqlAuthGuard) without that module importing UsersModule. The
// Phase 2 modules relied on this being available but never wired it, so the app
// could not boot; exporting UsersService globally fixes it without cycles.
@Global()
@Module({
  imports: [
    // Registers the User schema with Mongoose so UsersService can inject the model
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
    ]),
    FirebaseModule,
    ConsentsModule,
    WalletsModule,
    forwardRef(() => DevicesModule),
  ],
  providers: [
    UsersService,
    UsersResolver,
    GqlAuthGuard,
    RolesGuard,
    RoleLoader,
  ],
  exports: [UsersService], // Exports the service in case other modules need to look up users later
})
export class UsersModule {}
