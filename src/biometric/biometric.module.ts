import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FirebaseModule } from '../firebase/firebase.module';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { BiometricService } from './biometric.service';
import { BiometricResolver } from './biometric.resolver';
import {
  BiometricCredential,
  BiometricCredentialSchema,
} from './schemas/biometric-credential.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BiometricCredential.name, schema: BiometricCredentialSchema },
    ]),
    FirebaseModule,
    // GqlAuthGuard is instantiated in THIS module's context (it guards the
    // enrol/manage mutations), so its own deps must resolve here:
    //   • UsersModule   → UsersService (+ exports GqlAuthGuard itself)
    //   • DevicesModule → DevicesService (guard checks staff x-device-token)
    UsersModule,
    DevicesModule,
  ],
  providers: [BiometricService, BiometricResolver],
  exports: [BiometricService],
})
export class BiometricModule {}
