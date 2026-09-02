import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum NoteVisibility {
  /** Staff only. Must never reach the requester, by any path. */
  INTERNAL = 'INTERNAL',
  /** Shown to the requester verbatim. */
  CUSTOMER = 'CUSTOMER',
}
registerEnumType(NoteVisibility, { name: 'NoteVisibility' });

export type SupportTicketNoteDocument = SupportTicketNote & Document;

/**
 * One note on a ticket. Its OWN collection, and append-only.
 *
 * Not embedded in the ticket: notes are unbounded (a long dispute runs to
 * dozens) and a document that grows without limit is the classic Mongo
 * mistake. But the real reason is the visibility flag — keeping notes
 * separate means the customer-facing read is a DIFFERENT QUERY
 * (`visibility: CUSTOMER`) rather than a filter someone can forget to apply
 * when mapping an embedded array. An internal note leaking to the person
 * being discussed is the single worst failure this module can have.
 *
 * Append-only for a related reason: a customer-visible note that can be
 * edited after the customer has read it is a lie about what was said. There
 * is no update or delete path and none may be added — corrections are new
 * notes.
 */
@ObjectType()
@Schema({
  collection: 'support_ticket_notes',
  timestamps: { createdAt: true, updatedAt: false },
})
export class SupportTicketNote {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true, index: true })
  ticketId!: string;

  @Field()
  @Prop({ type: String, required: true })
  authorUid!: string;

  /** Denormalised — the trail must read correctly after the agent leaves. */
  @Field()
  @Prop({ type: String, required: true })
  authorName!: string;

  @Field(() => NoteVisibility)
  @Prop({ type: String, enum: NoteVisibility, required: true })
  visibility!: NoteVisibility;

  // Empty-string-compatible (default ''), not truly optional at the app
  // layer — SupportTicketsService.addNote requires body OR imageKey, mirroring
  // Message.text/imageKey (chat/schemas/message.schema.ts) so a photo-only
  // reply is expressible without inventing a placeholder caption.
  @Field()
  @Prop({ type: String, required: false, trim: true, default: '' })
  body!: string;

  // Private storage object key for an attached image
  // (support-tickets/<ticketId>/...). Not exposed directly as a GraphQL
  // field — resolved to a short-lived signed URL via SupportTicketNote.
  // imageUrl in support-ticket-note-image.resolver.ts, same split as
  // Message.imageKey/imageUrl.
  @Prop({ type: String, required: false, default: null })
  imageKey?: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const SupportTicketNoteSchema =
  SchemaFactory.createForClass(SupportTicketNote);

SupportTicketNoteSchema.index({ ticketId: 1, createdAt: 1 });
