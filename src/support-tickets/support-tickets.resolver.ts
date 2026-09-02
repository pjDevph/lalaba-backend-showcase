import {
  Args,
  ID,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { SupportTicketsService } from './support-tickets.service';
import {
  SupportTicket,
  TicketPriority,
  TicketStatus,
} from './schemas/support-ticket.schema';
import {
  NoteVisibility,
  SupportTicketNote,
} from './schemas/support-ticket-note.schema';
import { SupportTicketEvent } from './schemas/support-ticket-event.schema';
import { CreateTicketInput } from './dto/create-ticket.input';
import { TicketFilterInput } from './dto/ticket-filter.input';
import { PaginatedTickets, TicketMetrics } from './models/ticket-page.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

/**
 * Support tickets. Admin AND support, unlike most of the admin surface —
 * this is the one module whose primary user is a support agent rather than an
 * operator, so gating it to admin would make it useless.
 *
 * Everything here is staff-facing. When the customer app eventually shows a
 * customer their own tickets, that needs its own resolver scoped to
 * `requester.uid` and reading `customerVisibleNotes` — NOT these queries with
 * a filter bolted on, for the reason spelled out on the note schema.
 */
@Resolver(() => SupportTicket)
@Roles('admin', 'support')
@UseGuards(GqlAuthGuard, RolesGuard)
export class SupportTicketsResolver {
  constructor(private readonly ticketsService: SupportTicketsService) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  @Query(() => PaginatedTickets, { name: 'supportTickets' })
  async supportTickets(
    @Args('filter', { nullable: true }) filter?: TicketFilterInput,
  ): Promise<PaginatedTickets> {
    return this.ticketsService.find(filter ?? {});
  }

  @Query(() => SupportTicket, { name: 'supportTicket' })
  async supportTicket(
    @Args('ticketId', { type: () => ID }) ticketId: string,
  ): Promise<SupportTicket> {
    return this.ticketsService.findOne(ticketId);
  }

  @Query(() => TicketMetrics, { name: 'supportTicketMetrics' })
  async supportTicketMetrics(): Promise<TicketMetrics> {
    return this.ticketsService.metrics();
  }

  /** Both internal and customer-visible — this whole resolver is staff-only. */
  @ResolveField(() => [SupportTicketNote])
  async notes(@Parent() ticket: SupportTicket): Promise<SupportTicketNote[]> {
    return this.ticketsService.notes(String(ticket._id));
  }

  @ResolveField(() => [SupportTicketEvent])
  async events(@Parent() ticket: SupportTicket): Promise<SupportTicketEvent[]> {
    return this.ticketsService.events(String(ticket._id));
  }

  /**
   * When the first reply was due, or null once it has been sent. Computed
   * server-side so every screen counts down against the same target rather
   * than each re-deriving it from priority.
   */
  @ResolveField(() => Date, { nullable: true })
  firstResponseDueAt(@Parent() ticket: SupportTicket): Date | null {
    return this.ticketsService.firstResponseDueAt(ticket);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  @Mutation(() => SupportTicket)
  async createSupportTicket(
    @Args('input') input: CreateTicketInput,
    @CurrentUser() actor: User,
  ): Promise<SupportTicket> {
    return this.ticketsService.create(input, actor);
  }

  @Mutation(() => SupportTicketNote)
  async addSupportTicketNote(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @Args('body') body: string,
    @Args('visibility', { type: () => NoteVisibility })
    visibility: NoteVisibility,
    @CurrentUser() actor: User,
    @Args('imageKey', { type: () => String, nullable: true })
    imageKey?: string,
  ): Promise<SupportTicketNote> {
    return this.ticketsService.addNote(
      ticketId,
      body,
      visibility,
      actor,
      imageKey ?? undefined,
    );
  }

  /** Upload-first-reference-next — pass the returned key into addSupportTicketNote. */
  @Mutation(() => String)
  async uploadSupportTicketImage(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @Args('base64') base64: string,
    @Args('mimeType') mimeType: string,
    @CurrentUser() actor: User,
  ): Promise<string> {
    return this.ticketsService.uploadTicketImage(
      ticketId,
      actor,
      base64,
      mimeType,
    );
  }

  @Mutation(() => SupportTicket)
  async setSupportTicketStatus(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @Args('status', { type: () => TicketStatus }) status: TicketStatus,
    // Explicit () => String on every nullable arg: a `string | null` union has
    // no reflectable design type, so the implicit form fails at schema-BUILD
    // time — which typecheck and unit tests both sail past.
    @Args('reason', { type: () => String, nullable: true })
    reason: string | null,
    @CurrentUser() actor: User,
  ): Promise<SupportTicket> {
    return this.ticketsService.changeStatus(ticketId, status, actor, reason);
  }

  @Mutation(() => SupportTicket)
  async assignSupportTicket(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    /** Null unassigns. */
    @Args('assigneeUid', { type: () => ID, nullable: true })
    assigneeUid: string | null,
    @Args('reason', { type: () => String, nullable: true })
    reason: string | null,
    @CurrentUser() actor: User,
  ): Promise<SupportTicket> {
    return this.ticketsService.assign(ticketId, assigneeUid, actor, reason);
  }

  @Mutation(() => SupportTicket)
  async setSupportTicketPriority(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @Args('priority', { type: () => TicketPriority }) priority: TicketPriority,
    @CurrentUser() actor: User,
  ): Promise<SupportTicket> {
    return this.ticketsService.setPriority(ticketId, priority, actor);
  }

  @Mutation(() => SupportTicket)
  async resolveSupportTicket(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @Args('resolutionCode') resolutionCode: string,
    @Args('note', { type: () => String, nullable: true }) note: string | null,
    @CurrentUser() actor: User,
  ): Promise<SupportTicket> {
    return this.ticketsService.resolve(ticketId, resolutionCode, actor, note);
  }
}
