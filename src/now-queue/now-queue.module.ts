import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../users/schemas/user.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntrySchema,
} from '../wallets/schemas/wallet-ledger-entry.schema';
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
import { NowQueueResolver } from './now-queue.resolver';
import { NowQueueService } from './now-queue.service';

/** Reads only — registers the schemas rather than the owning modules. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: WalletLedgerEntry.name, schema: WalletLedgerEntrySchema },
      { name: KycDocument.name, schema: KycDocumentSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
    ]),
  ],
  providers: [NowQueueResolver, NowQueueService],
})
export class NowQueueModule {}
