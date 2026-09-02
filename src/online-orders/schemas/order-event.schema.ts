import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { OrderStatus } from './order-status.enum';

export type OrderEventDocument = OrderEvent & Document;

// Append-only lifecycle timeline — never updated after creation. One row
// per transition/material change, so the full history survives regardless
// of what the order's current state later becomes.
@ObjectType()
@Schema({
  collection: 'order_events',
  timestamps: { createdAt: true, updatedAt: false },
})
export class OrderEvent {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'OnlineOrder', required: true })
  orderId!: string;

  @Field()
  @Prop({ required: true })
  sequence!: number;

  @Field({ nullable: true })
  @Prop({ type: String, enum: OrderStatus, default: null })
  fromStatus?: OrderStatus;

  @Field()
  @Prop({ type: String, enum: OrderStatus, required: true })
  toStatus!: OrderStatus;

  @Field()
  @Prop({ required: true })
  actorUid!: string;

  @Field()
  @Prop({ required: true })
  actorRole!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  note?: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const OrderEventSchema = SchemaFactory.createForClass(OrderEvent);
OrderEventSchema.index({ orderId: 1, sequence: 1 }, { unique: true });
