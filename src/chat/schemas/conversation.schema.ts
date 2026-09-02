import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

export type ConversationDocument = Conversation & Document;

// Who the customer is talking to on the non-customer side of a thread.
//   PROVIDER — the shop/home-washer, scoped to ONE order. Each order the
//              customer places opens its own thread and that thread closes to
//              new messages once the order concludes — a fresh order is a fresh
//              session, never a continuation of the last.
//   COURIER  — a specific rider on a specific order+leg, keyed per
//              (customer, courier, order, leg). The session IS the leg: it closes
//              to new messages the moment that leg is handed over (pickup
//              collected / delivery dropped off), so a rider working both legs
//              gets two threads, not one running conversation.
export enum ConversationKind {
  PROVIDER = 'provider',
  COURIER = 'courier',
}
registerEnumType(ConversationKind, { name: 'ConversationKind' });

// Which delivery leg a courier thread belongs to (drives the "Pickup rider" /
// "Return rider" label the customer sees). Null for provider threads.
export enum ChatLegType {
  PICKUP = 'pickup',
  RETURN = 'return',
}
registerEnumType(ChatLegType, { name: 'ChatLegType' });

// A thread's non-customer participant uid/name/type live in the provider* fields
// regardless of kind — for COURIER threads they hold the rider's uid/name (so
// `myConversations` and the participant check work unchanged for couriers too).
// Optionally anchored to an order. Unread counts are kept per side so each app
// can badge its own tab.
@ObjectType()
@Schema({ collection: 'conversations', timestamps: true })
export class Conversation {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true })
  customerUid!: string;

  @Field()
  @Prop({ type: String, required: true })
  customerName!: string;

  @Field()
  @Prop({ type: String, required: true })
  providerUid!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true })
  branchId!: string;

  @Field(() => ProviderType)
  @Prop({ type: String, enum: ProviderType, required: true })
  providerType!: ProviderType;

  @Field()
  @Prop({ type: String, required: true })
  providerName!: string;

  @Field(() => ConversationKind)
  @Prop({
    type: String,
    enum: ConversationKind,
    default: ConversationKind.PROVIDER,
  })
  kind!: ConversationKind;

  @Field(() => ChatLegType, { nullable: true })
  @Prop({ type: String, enum: ChatLegType, default: null })
  legType?: ChatLegType;

  @Field(() => ID, { nullable: true })
  @Prop({ type: String, default: null })
  orderId?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  lastMessageText?: string;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  lastMessageAt?: Date;

  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  customerUnread!: number;

  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  providerUnread!: number;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
// One provider thread per (customer, provider, order) — every order is its own
// chat session, so a new order never reuses the previous order's thread.
ConversationSchema.index(
  { customerUid: 1, providerUid: 1, orderId: 1 },
  {
    // Left auto-named: this index already exists in deployed databases, and
    // renaming it would collide with the live one on the same key pattern.
    unique: true,
    partialFilterExpression: { kind: ConversationKind.PROVIDER },
  },
);
// One courier thread per (customer, courier, order, LEG) — the pickup and the
// return are separate sessions even when the same rider works both, so the
// return can't continue in the (already closed) pickup thread. The leg is part
// of the key, not just a label; without it the two collapse into one.
// Explicitly named, and note the extra `legType` key: the previous version had
// the SAME key pattern as the provider index above, so Mongo only ever created
// one of the two — the courier uniqueness constraint silently did not exist.
ConversationSchema.index(
  { customerUid: 1, providerUid: 1, orderId: 1, legType: 1 },
  {
    name: 'courier_leg_thread_unique',
    unique: true,
    partialFilterExpression: { kind: ConversationKind.COURIER },
  },
);
ConversationSchema.index({ customerUid: 1, lastMessageAt: -1 });
ConversationSchema.index({ providerUid: 1, lastMessageAt: -1 });
