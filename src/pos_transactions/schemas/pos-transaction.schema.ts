import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum PaymentMethod {
  cash = 'cash',
  gcash = 'gcash',
  maya = 'maya',
  qph = 'qph',
  card = 'card',
  bank_transfer = 'bank_transfer',
}
registerEnumType(PaymentMethod, { name: 'PaymentMethod' });

export enum TransactionStatus {
  COMPLETED = 'completed',
  REFUNDED = 'refunded',
  ADD_ON = 'add_on',
}
registerEnumType(TransactionStatus, { name: 'TransactionStatus' });

export type PosTransactionDocument = PosTransaction & Document;

@ObjectType()
@Schema({
  collection: 'pos_transactions',
  timestamps: { createdAt: true, updatedAt: false },
})
export class PosTransaction {
  @Field(() => ID) _id!: string;

  @Field()
  @Prop({ type: String, ref: 'PosOrder', required: true })
  orderId!: string;

  // Nullable ONLY for refunds. A payment transaction always carries the method
  // the cashier tendered; a REFUNDED record is written against the original
  // payment, and when that original cannot be found there is genuinely no
  // method to name — POS is walk-in trade, so a missing original must not block
  // giving a customer their money back. Recording null is honest; inventing a
  // method would falsify a financial record.
  @Field(() => PaymentMethod, { nullable: true })
  // `type: String` is required: the union `PaymentMethod | null` is ambiguous
  // to Mongoose's metadata reflection, which cannot infer it on its own.
  @Prop({ type: String, required: false, enum: PaymentMethod, default: null })
  paymentMethod?: PaymentMethod | null;

  @Field({ nullable: true })
  @Prop({ default: null })
  referenceId?: string;

  @Field(() => Float)
  @Prop({ required: true })
  totalAmount!: number;

  @Field(() => Float)
  @Prop({ required: true })
  amountPaid!: number;

  @Field(() => Float)
  @Prop({ required: true, default: 0 })
  change!: number;

  @Field(() => TransactionStatus)
  @Prop({ required: true, enum: TransactionStatus })
  status!: TransactionStatus;

  @Field()
  @Prop({ required: true })
  processedBy!: string;

  @Field()
  @Prop({ required: true })
  processedByType!: string;

  @Field({ nullable: true }) createdAt?: Date;
}

export const PosTransactionSchema =
  SchemaFactory.createForClass(PosTransaction);
