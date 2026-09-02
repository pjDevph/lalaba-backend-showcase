import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { PaymentMethod } from './order-status.enum';

// Mirrors pos_transactions almost exactly (see phase2-settled-decisions.md
// §14/§24 payment model note) — one order can have more than one row, e.g.
// the original pickup/receipt payment (COMPLETED) plus a later ADD_ON
// transaction if a quality-hold surcharge gets collected by the return
// courier at delivery, since the pickup courier already left.
export enum OnlineTransactionStatus {
  COMPLETED = 'completed',
  REFUNDED = 'refunded',
  ADD_ON = 'add_on',
}
registerEnumType(OnlineTransactionStatus, { name: 'OnlineTransactionStatus' });

export type OnlineTransactionDocument = OnlineTransaction & Document;

@ObjectType()
@Schema({
  collection: 'online_transactions',
  timestamps: { createdAt: true, updatedAt: false },
})
export class OnlineTransaction {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'OnlineOrder', required: true })
  orderId!: string;

  @Field(() => PaymentMethod)
  @Prop({ type: String, required: true, enum: PaymentMethod })
  paymentMethod!: PaymentMethod;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  referenceId?: string; // required for EWALLET_OUTSIDE_APP — the courier's captured transfer reference

  @Field(() => Float)
  @Prop({ required: true })
  amountCentavos!: number;

  // Cash tender/change (GAP-H-017) — optional until DECISION_REQUIRED-004
  // settles the full tender model. Integer centavos.
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  tenderedCentavos?: number;

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  changeCentavos?: number;

  @Field(() => OnlineTransactionStatus)
  @Prop({ type: String, required: true, enum: OnlineTransactionStatus })
  status!: OnlineTransactionStatus;

  @Field()
  @Prop({ required: true })
  collectedByUid!: string;

  @Field()
  @Prop({ required: true })
  collectedByRole!: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const OnlineTransactionSchema =
  SchemaFactory.createForClass(OnlineTransaction);
OnlineTransactionSchema.index({ orderId: 1, createdAt: -1 });
