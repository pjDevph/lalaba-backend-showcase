import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionResolver } from './account-deletion.resolver';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  PosOrder,
  PosOrderSchema,
} from '../pos_orders/schemas/pos-order.schema';
import {
  WasherBooking,
  WasherBookingSchema,
} from '../washer/schemas/washer-booking.schema';
import { Device, DeviceSchema } from '../devices/schemas/device.schema';
import {
  ActivityLog,
  ActivityLogSchema,
} from '../activity-logs/schemas/activity-log.schema';
import {
  AccountDeletionRecord,
  AccountDeletionRecordSchema,
} from './schemas/account-deletion-record.schema';
import { AccountDeletionScheduler } from './account-deletion.scheduler';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { CourierVerificationModule } from '../courier-verification/courier-verification.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: PosOrder.name, schema: PosOrderSchema },
      // Legacy, read-mostly collections: blocked on for deletion, and their
      // denormalized customer contact is redacted at erasure time.
      { name: WasherBooking.name, schema: WasherBookingSchema },
      { name: Device.name, schema: DeviceSchema },
      { name: ActivityLog.name, schema: ActivityLogSchema },
      { name: AccountDeletionRecord.name, schema: AccountDeletionRecordSchema },
    ]),
    UsersModule,
    DevicesModule,
    // Erasure deletes the courier's selfie objects from the public bucket.
    CourierVerificationModule,
  ],
  providers: [
    AccountDeletionService,
    AccountDeletionResolver,
    AccountDeletionScheduler,
  ],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
