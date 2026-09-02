import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SupportTicketsService } from './support-tickets.service';
import { SupportTicketsResolver } from './support-tickets.resolver';
import { MySupportTicketsResolver } from './my-support-tickets.resolver';
import {
  SupportTicket,
  SupportTicketSchema,
} from './schemas/support-ticket.schema';
import {
  SupportTicketNote,
  SupportTicketNoteSchema,
} from './schemas/support-ticket-note.schema';
import {
  SupportTicketEvent,
  SupportTicketEventSchema,
} from './schemas/support-ticket-event.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { StorageModule } from '../storage/storage.module';
import { SupportTicketNoteImageResolver } from './support-ticket-note-image.resolver';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupportTicket.name, schema: SupportTicketSchema },
      { name: SupportTicketNote.name, schema: SupportTicketNoteSchema },
      { name: SupportTicketEvent.name, schema: SupportTicketEventSchema },
      // Read-only: resolving a requester's snapshot at creation and checking
      // that an assignee is actually staff. forFeature registers the model
      // without importing UsersModule, so no cycle.
      { name: User.name, schema: UserSchema },
      // Required for `.populate('role')` in the service: without the Role
      // model registered, populate throws MissingSchemaError at runtime — and
      // the staff check on assignment depends on a populated role.
      { name: Role.name, schema: RoleSchema },
    ]),
    StorageModule,
  ],
  providers: [
    SupportTicketsService,
    SupportTicketsResolver,
    MySupportTicketsResolver,
    SupportTicketNoteImageResolver,
  ],
  exports: [SupportTicketsService],
})
export class SupportTicketsModule {}
