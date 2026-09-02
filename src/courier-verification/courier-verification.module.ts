import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CourierVerificationService } from './courier-verification.service';
import { CourierVerificationResolver } from './courier-verification.resolver';
import {
  CourierSelfie,
  CourierSelfieSchema,
} from './schemas/courier-selfie.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CourierSelfie.name, schema: CourierSelfieSchema },
      // Submit/revoke write the denormalized gate state onto the user.
      { name: User.name, schema: UserSchema },
    ]),
    StorageModule,
    // Both required by GqlAuthGuard, which every resolver here is guarded by.
    UsersModule,
    DevicesModule,
  ],
  providers: [CourierVerificationService, CourierVerificationResolver],
  exports: [CourierVerificationService],
})
export class CourierVerificationModule {}
