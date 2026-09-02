import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Who sent a message. 'customer'/provider side, or 'system' for auto-injected
// order-status updates (rendered as a centered pill, not a bubble).
export enum ChatSenderRole {
  CUSTOMER = 'customer',
  MERCHANT = 'merchant',
  WASHER = 'washer',
  COURIER = 'courier',
  SYSTEM = 'system',
  // A support/admin agent joining an existing customer/provider thread — see
  // ChatService.adminSendMessage. Distinct from SYSTEM (auto-injected status
  // pills, no real sender) and from every participant role (a support reply
  // is neither the customer nor the provider — squeezing it into one of
  // those would misrepresent who actually said it to the other side).
  SUPPORT = 'support',
}
registerEnumType(ChatSenderRole, { name: 'ChatSenderRole' });

export type MessageDocument = Message & Document;

@ObjectType()
@Schema({ collection: 'chat_messages', timestamps: true })
export class Message {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true })
  conversationId!: string;

  @Field()
  @Prop({ type: String, required: true })
  senderUid!: string;

  @Field(() => ChatSenderRole)
  @Prop({ type: String, enum: ChatSenderRole, required: true })
  senderRole!: ChatSenderRole;

  @Field()
  @Prop({ type: String, required: false, trim: true, default: '' })
  text!: string;

  // Private storage object key for an attached image (chat/<conversationId>/...).
  // Not exposed directly as a GraphQL field — resolved to a short-lived signed
  // URL via Message.imageUrl in chat.resolver.ts, same split as HandoverProof's
  // stored key vs its resolved URL.
  @Prop({ type: String, required: false, default: null })
  imageKey?: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ conversationId: 1, createdAt: 1 });
