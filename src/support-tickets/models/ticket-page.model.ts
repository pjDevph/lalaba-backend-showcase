import { ObjectType, Field, Int } from '@nestjs/graphql';
import { SupportTicket } from '../schemas/support-ticket.schema';

@ObjectType()
export class PaginatedTickets {
  @Field(() => [SupportTicket]) data!: SupportTicket[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}

/** Inbox header counts. Computed over every ticket, never over one page. */
@ObjectType()
export class TicketMetrics {
  @Field(() => Int) open!: number;
  @Field(() => Int) inProgress!: number;
  @Field(() => Int) waitingOnCustomer!: number;
  @Field(() => Int) escalated!: number;
  /** Active tickets nobody owns — the queue that actually needs watching. */
  @Field(() => Int) unassigned!: number;
  /**
   * Active tickets past their first-response target with no reply sent.
   * Excludes anything waiting on the customer: that is not us being slow.
   */
  @Field(() => Int) breachedFirstResponse!: number;
}
