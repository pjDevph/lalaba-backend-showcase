import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  SupportTicket,
  SupportTicketSchema,
} from '../support-tickets/schemas/support-ticket.schema';
import { SearchResolver } from './search.resolver';
import { SearchService } from './search.service';

/**
 * Registers the schemas it reads directly rather than importing the four
 * owning modules. It only ever READS, it must not inherit their services'
 * write paths, and importing OnlineOrdersModule for a search box would drag in
 * the entire order lifecycle.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
    ]),
  ],
  providers: [SearchResolver, SearchService],
  exports: [SearchService],
})
export class SearchModule {}
