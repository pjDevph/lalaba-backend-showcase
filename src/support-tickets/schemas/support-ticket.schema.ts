import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Where the complaint came in from. Tagged rather than inferred, because the
 * same person can reach support four different ways about the same order, and
 * "which channel is generating the most tickets" is a staffing question.
 */
export enum TicketSource {
  CUSTOMER_APP = 'CUSTOMER_APP',
  PARTNER_APP = 'PARTNER_APP',
  COURIER_APP = 'COURIER_APP',
  CHAT = 'CHAT',
  WEBSITE = 'WEBSITE',
  PHONE = 'PHONE',
  /** Raised by an agent from inside the panel, on someone's behalf. */
  ADMIN = 'ADMIN',
}
registerEnumType(TicketSource, { name: 'TicketSource' });

/**
 * WAITING_ON_CUSTOMER is a first-class state, not a flavour of IN_PROGRESS.
 * It is the difference between "we are slow" and "they have not replied",
 * and conflating the two makes every SLA number meaningless.
 */
export enum TicketStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  WAITING_ON_CUSTOMER = 'WAITING_ON_CUSTOMER',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}
registerEnumType(TicketStatus, { name: 'TicketStatus' });

/** Statuses where the clock is on US. Used for SLA and for the default queue. */
export const TICKET_ACTIVE_STATUSES: TicketStatus[] = [
  TicketStatus.OPEN,
  TicketStatus.IN_PROGRESS,
  TicketStatus.ESCALATED,
];

export enum TicketPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}
registerEnumType(TicketPriority, { name: 'TicketPriority' });

/**
 * What the ticket is ABOUT — a structured code, so "what do we get complained
 * at for" is answerable without reading every subject line.
 */
export enum TicketCategory {
  ORDER_LATE = 'ORDER_LATE',
  ORDER_DAMAGED = 'ORDER_DAMAGED',
  ORDER_MISSING_ITEMS = 'ORDER_MISSING_ITEMS',
  PAYMENT_DISPUTE = 'PAYMENT_DISPUTE',
  REFUND_REQUEST = 'REFUND_REQUEST',
  WALLET_TOPUP = 'WALLET_TOPUP',
  COURIER_CONDUCT = 'COURIER_CONDUCT',
  PROVIDER_CONDUCT = 'PROVIDER_CONDUCT',
  /** A washer/merchant reporting a customer — the partner-side mirror of
   *  COURIER_CONDUCT/PROVIDER_CONDUCT, which only cover complaints made
   *  ABOUT a courier/provider, not BY one. */
  CUSTOMER_CONDUCT = 'CUSTOMER_CONDUCT',
  ACCOUNT_ACCESS = 'ACCOUNT_ACCESS',
  VERIFICATION = 'VERIFICATION',
  APP_BUG = 'APP_BUG',
  OTHER = 'OTHER',
}
registerEnumType(TicketCategory, { name: 'TicketCategory' });

/** Who raised it. Snapshotted, so the ticket still reads after account deletion. */
@ObjectType()
export class TicketRequester {
  @Field() uid!: string;
  @Field() displayName!: string;
  @Field({ nullable: true }) email?: string;
  @Field({ nullable: true }) phone?: string;
  /** customer | washer | merchant | courier — who they were when they wrote in. */
  @Field() role!: string;
}

/**
 * The records this ticket is about. All optional and all independent: a
 * payment dispute has an order and a provider, an account-access ticket has
 * neither.
 */
@ObjectType()
export class TicketLinks {
  @Field(() => ID, { nullable: true }) orderId?: string;
  @Field(() => ID, { nullable: true }) providerBranchId?: string;
  /** A top-up intent id or gateway reference, for money tickets. */
  @Field({ nullable: true }) paymentReference?: string;
}

export type SupportTicketDocument = SupportTicket & Document;

@ObjectType()
@Schema({ collection: 'support_tickets', timestamps: true })
export class SupportTicket {
  @Field(() => ID)
  _id!: string;

  /**
   * Short, human-readable, and the whole reason this exists: orders have no
   * such number and support has been reading out Mongo ObjectIds. Assigned by
   * a counter at creation — see SupportTicketsService.nextTicketNumber.
   */
  @Field()
  @Prop({ type: String, required: true, unique: true })
  ticketNumber!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  subject!: string;

  @Field()
  @Prop({ type: String, required: true })
  body!: string;

  @Field(() => TicketSource)
  @Prop({ type: String, enum: TicketSource, required: true })
  source!: TicketSource;

  @Field(() => TicketStatus)
  @Prop({
    type: String,
    enum: TicketStatus,
    default: TicketStatus.OPEN,
    index: true,
  })
  status!: TicketStatus;

  @Field(() => TicketPriority)
  @Prop({ type: String, enum: TicketPriority, default: TicketPriority.NORMAL })
  priority!: TicketPriority;

  @Field(() => TicketCategory)
  @Prop({ type: String, enum: TicketCategory, required: true })
  category!: TicketCategory;

  @Field(() => TicketRequester)
  @Prop({ type: Object, required: true })
  requester!: TicketRequester;

  @Field(() => TicketLinks)
  @Prop({ type: Object, default: () => ({}) })
  links!: TicketLinks;

  @Field({ nullable: true })
  @Prop({ type: String, default: null, index: true })
  assignedToUid?: string;

  /** Denormalised so the inbox can show an assignee without a join per row. */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  assignedToName?: string;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  assignedAt?: Date | null;

  /**
   * Set ONCE, by the first customer-visible reply, and never overwritten.
   * Re-stamping it on later replies would make every reopened ticket look
   * like it was answered instantly.
   */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  firstResponseAt?: Date | null;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  resolvedAt?: Date | null;

  /**
   * When the REQUESTER last viewed this thread — the customer/partner-app
   * mirror of firstResponseAt/resolvedAt, but on the other side of the
   * conversation. Unread = any CUSTOMER-visibility note newer than this that
   * she didn't author herself. A timestamp rather than Conversation's
   * incrementing unread counter: one field, nothing to keep in sync across
   * every place a note gets added.
   */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  requesterLastReadAt?: Date | null;

  /** Structured, like every other decision code in the platform. */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  resolutionCode?: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const SupportTicketSchema = SchemaFactory.createForClass(SupportTicket);

// The inbox's default sort and its two commonest filters.
SupportTicketSchema.index({ status: 1, createdAt: -1 });
SupportTicketSchema.index({ assignedToUid: 1, status: 1, createdAt: -1 });
SupportTicketSchema.index({ 'requester.uid': 1, createdAt: -1 });
SupportTicketSchema.index({ 'links.orderId': 1 });
