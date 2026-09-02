import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ForbiddenException, UseGuards } from '@nestjs/common';

import { SupportTicketsService } from './support-tickets.service';
import {
  SupportTicket,
  TicketSource,
  TicketStatus,
} from './schemas/support-ticket.schema';
import {
  NoteVisibility,
  SupportTicketNote,
} from './schemas/support-ticket-note.schema';
import { CreateTicketInput } from './dto/create-ticket.input';
import { CreateMyTicketInput } from './dto/create-my-ticket.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { MaxLengthPipe } from '../common/pipes/max-length.pipe';
import { TEXT_LIMITS } from '../common/validators/text-limits';

/**
 * The customer/partner-app counterpart to SupportTicketsResolver, split into
 * its own class rather than added to that one — the two must never share a
 * @Roles gate. Deliberately customer/washer/merchant only: staff and courier
 * raise problems through their own existing support channel, not this one.
 *
 * Every method re-asserts ticket.requester.uid === the caller, even though
 * these are all read/write-your-own operations — never trust a client-
 * supplied ticketId to actually belong to the caller.
 */
@Resolver()
@Roles('customer', 'washer', 'merchant')
@UseGuards(GqlAuthGuard, RolesGuard)
export class MySupportTicketsResolver {
  constructor(private readonly ticketsService: SupportTicketsService) {}

  private async ownTicketOrThrow(
    ticketId: string,
    actor: User,
  ): Promise<SupportTicket> {
    const ticket = await this.ticketsService.findOne(ticketId);
    if (ticket.requester.uid !== String(actor._id)) {
      throw new ForbiddenException('Not your ticket');
    }
    return ticket;
  }

  @Query(() => SupportTicket, { name: 'myOpenSupportTicket', nullable: true })
  async myOpenSupportTicket(
    @CurrentUser() actor: User,
  ): Promise<SupportTicket | null> {
    return this.ticketsService.findMostRecentActiveForRequester(
      String(actor._id),
    );
  }

  @Query(() => [SupportTicketNote], { name: 'mySupportTicketNotes' })
  async mySupportTicketNotes(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @CurrentUser() actor: User,
  ): Promise<SupportTicketNote[]> {
    await this.ownTicketOrThrow(ticketId, actor);
    // customerVisibleNotes(), never notes() — INTERNAL notes must never reach
    // this resolver (see the doc comment on SupportTicketsResolver).
    return this.ticketsService.customerVisibleNotes(ticketId);
  }

  @Mutation(() => SupportTicket, { name: 'createMySupportTicket' })
  async createMySupportTicket(
    @Args('input') input: CreateMyTicketInput,
    @CurrentUser() actor: User,
  ): Promise<SupportTicket> {
    // Reuses the same create() the staff resolver uses — the customer- and
    // partner-facing input is just a narrower shape (no requesterUid/source/
    // priority override) filled in from the caller herself.
    const full: CreateTicketInput = {
      requesterUid: String(actor._id),
      subject: input.subject,
      body: input.body,
      category: input.category,
      orderId: input.orderId,
      // @Roles already guarantees the caller is customer/washer/merchant —
      // role.roleId (populated by GqlAuthGuard, same field it gates on
      // itself) just picks which of the two channels to tag.
      source:
        (actor.role as unknown as Role)?.roleId === 'customer'
          ? TicketSource.CUSTOMER_APP
          : TicketSource.PARTNER_APP,
    };
    return this.ticketsService.create(full, actor);
  }

  @Mutation(() => SupportTicketNote, { name: 'addMySupportTicketNote' })
  async addMySupportTicketNote(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    // Capped here because a scalar arg is validated by nothing otherwise —
    // @MaxLength only runs on @InputType objects, so this reply was unbounded
    // while the ticket it belongs to was capped at TEXT_LIMITS.LONG.
    @Args('body', new MaxLengthPipe(TEXT_LIMITS.LONG, 'Message'))
    body: string,
    @CurrentUser() actor: User,
    // Upload-first-reference-next, same shape as chat's sendMessage(imageKey):
    // the caller uploads via uploadMySupportTicketImage first and passes the
    // returned key in here.
    @Args('imageKey', { type: () => String, nullable: true })
    imageKey?: string,
  ): Promise<SupportTicketNote> {
    await this.ownTicketOrThrow(ticketId, actor);
    return this.ticketsService.addNote(
      ticketId,
      body,
      NoteVisibility.CUSTOMER,
      actor,
      imageKey ?? undefined,
    );
  }

  @Mutation(() => String, { name: 'uploadMySupportTicketImage' })
  async uploadMySupportTicketImage(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @Args('base64') base64: string,
    @Args('mimeType') mimeType: string,
    @CurrentUser() actor: User,
  ): Promise<string> {
    await this.ownTicketOrThrow(ticketId, actor);
    return this.ticketsService.uploadTicketImage(
      ticketId,
      actor,
      base64,
      mimeType,
    );
  }

  @Mutation(() => Boolean, { name: 'markMySupportTicketRead' })
  async markMySupportTicketRead(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @CurrentUser() actor: User,
  ): Promise<boolean> {
    await this.ownTicketOrThrow(ticketId, actor);
    return this.ticketsService.markRequesterRead(ticketId);
  }

  /**
   * The requester ending her own session — distinct from an agent's
   * resolveSupportTicket (which requires a resolutionCode; a formal
   * determination of what happened). This is just "I'm done for now",
   * reuses the existing changeStatus() → CLOSED, which is exactly what
   * frees findMostRecentActiveForRequester() to start a genuinely fresh
   * ticket the next time she reports something.
   */
  @Mutation(() => SupportTicket, { name: 'closeMySupportTicket' })
  async closeMySupportTicket(
    @Args('ticketId', { type: () => ID }) ticketId: string,
    @CurrentUser() actor: User,
  ): Promise<SupportTicket> {
    await this.ownTicketOrThrow(ticketId, actor);
    return this.ticketsService.changeStatus(
      ticketId,
      TicketStatus.CLOSED,
      actor,
    );
  }
}
