import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { KycService } from './kyc.service';
import { KycResolver } from './kyc.resolver';
import { KycDocument, KycDocumentSchema } from './schemas/kyc-document.schema';
import {
  KycAuditEvent,
  KycAuditEventSchema,
} from './schemas/kyc-audit-event.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KycDocument.name, schema: KycDocumentSchema },
      { name: KycAuditEvent.name, schema: KycAuditEventSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      // Review-queue rows resolve the submitting owner's email.
      { name: User.name, schema: UserSchema },
    ]),
    StorageModule,
    UsersModule,
    DevicesModule,
    // Approve/reject push the outcome to the provider's owner. NotificationsModule
    // sits in the Users→Devices→Notifications→Users cycle and forwardRef's both
    // sides, so importing it here is safe without another forwardRef.
    NotificationsModule,
  ],
  providers: [KycService, KycResolver],
  exports: [KycService],
})
export class KycModule {}
