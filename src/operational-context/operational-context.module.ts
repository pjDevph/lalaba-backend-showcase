import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import {
  KycDocument,
  KycDocumentSchema,
} from '../kyc/schemas/kyc-document.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  SupportTicket,
  SupportTicketSchema,
} from '../support-tickets/schemas/support-ticket.schema';
import { OperationalContextResolver } from './operational-context.resolver';
import { OperationalContextService } from './operational-context.service';

/**
 * Registers the schemas it reads rather than importing the seven owning
 * modules: it only ever READS, and it must not inherit their write paths.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: KycDocument.name, schema: KycDocumentSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
    ]),
  ],
  providers: [OperationalContextResolver, OperationalContextService],
})
export class OperationalContextModule {}
