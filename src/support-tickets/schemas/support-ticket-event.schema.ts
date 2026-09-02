import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum TicketEventType {
  CREATED = 'CREATED',
  STATUS_CHANGED = 'STATUS_CHANGED',
  ASSIGNED = 'ASSIGNED',
  UNASSIGNED = 'UNASSIGNED',
  ESCALATED = 'ESCALATED',
  PRIORITY_CHANGED = 'PRIORITY_CHANGED',
  RESOLVED = 'RESOLVED',
  REOPENED = 'REOPENED',
}
registerEnumType(TicketEventType, { name: 'TicketEventType' });

export type SupportTicketEventDocument = SupportTicketEvent & Document;

/**
 * What HAPPENED to a ticket, as opposed to what was SAID about it.
 *
 * Deliberately not the same collection as notes, even though the panel
 * interleaves both into one timeline. Notes carry a visibility flag that
 * decides whether a human's words reach the customer; events are structural
 * and never customer-visible. Putting them together would mean one collection
 * where some rows are safe to show and others are not — exactly the
 * distinction the note schema exists to keep unambiguous.
 *
 * Append-only, like every other trail in this platform.
 */
@ObjectType()
@Schema({
  collection: 'support_ticket_events',
  timestamps: { createdAt: true, updatedAt: false },
})
export class SupportTicketEvent {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true, index: true })
  ticketId!: string;

  @Field(() => TicketEventType)
  @Prop({ type: String, enum: TicketEventType, required: true })
  type!: TicketEventType;

  @Field()
  @Prop({ type: String, required: true })
  actorUid!: string;

  @Field()
  @Prop({ type: String, required: true })
  actorName!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  fromValue?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  toValue?: string;

  /**
   * Why. Required by the service for escalation and reassignment — a handoff
   * with no stated reason is how a ticket ends up bouncing between two agents
   * who each think the other owns it.
   */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  reason?: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const SupportTicketEventSchema =
  SchemaFactory.createForClass(SupportTicketEvent);

SupportTicketEventSchema.index({ ticketId: 1, createdAt: 1 });
