import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum TopUpIntentStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}
registerEnumType(TopUpIntentStatus, { name: 'TopUpIntentStatus' });

export type TopUpIntentDocument = TopUpIntent & Document;

/**
 * Secure top-up lifecycle (RISK-P0-003): `initializeTopUp` no longer credits
 * the wallet — it creates a PENDING intent and hands the amount to the
 * payment gateway. Only the verified webhook path
 * (`WalletsService.postVerifiedTopUp`) may move an intent to SUCCEEDED and
 * append the credit to the ledger. The intent's own `_id` doubles as the
 * gateway `external_id` / ledger idempotency reference.
 */
@ObjectType()
@Schema({
  collection: 'topup_intents',
  timestamps: { createdAt: true, updatedAt: false },
})
export class TopUpIntent {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, ref: 'Branch', required: true, index: true })
  branchId!: string;

  @Field(() => Int)
  @Prop({ type: Number, required: true })
  amountCentavos!: number;

  @Field(() => TopUpIntentStatus)
  @Prop({
    type: String,
    enum: TopUpIntentStatus,
    default: TopUpIntentStatus.PENDING,
  })
  status!: TopUpIntentStatus;

  /** Gateway-side invoice id (Xendit invoice `id`). */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  xenditInvoiceId?: string;

  /** Hosted checkout URL the FE opens for the user to pay. */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  invoiceUrl?: string;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  resolvedAt?: Date;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const TopUpIntentSchema = SchemaFactory.createForClass(TopUpIntent);
TopUpIntentSchema.index({ branchId: 1, createdAt: -1 });
