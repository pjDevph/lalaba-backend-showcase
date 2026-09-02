import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { DirectoryService } from './directory.service';
import { DirectoryResolver } from './directory.resolver';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  SupportTicket,
  SupportTicketSchema,
} from '../support-tickets/schemas/support-ticket.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import { Device, DeviceSchema } from '../devices/schemas/device.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { FirebaseModule } from '../firebase/firebase.module';

/**
 * Every model here is registered READ-ONLY for the directory's own queries —
 * nothing in this module writes to the database. FirebaseModule is the one
 * exception to "read-only": `impersonate` mints a Firebase credential, which
 * is not a Mongo write but is very much an action.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: Device.name, schema: DeviceSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: Branch.name, schema: BranchSchema },
    ]),
    FirebaseModule,
  ],
  providers: [DirectoryService, DirectoryResolver],
})
export class DirectoryModule {}
