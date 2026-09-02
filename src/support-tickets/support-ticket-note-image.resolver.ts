import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { SupportTicketsService } from './support-tickets.service';
import { SupportTicketNote } from './schemas/support-ticket-note.schema';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';

/**
 * `imageUrl` on SupportTicketNote — a SEPARATE resolver class from both
 * SupportTicketsResolver (staff, admin/support only) and
 * MySupportTicketsResolver (requester, customer/washer/merchant only), so
 * this field resolves the same way no matter which top-level query produced
 * the note. Safe to leave role-ungated here: WHICH notes a caller can see is
 * already decided before this ever runs — SupportTicketsResolver.notes() is
 * staff-gated, MySupportTicketsResolver.mySupportTicketNotes() is ownership-
 * and CUSTOMER-visibility-filtered. This only signs a key on an object the
 * caller already legitimately holds.
 */
@Resolver(() => SupportTicketNote)
@UseGuards(GqlAuthGuard)
export class SupportTicketNoteImageResolver {
  constructor(private readonly ticketsService: SupportTicketsService) {}

  @ResolveField(() => String, { nullable: true })
  async imageUrl(@Parent() note: SupportTicketNote): Promise<string | null> {
    return this.ticketsService.resolveNoteImageUrl(note.imageKey);
  }
}
