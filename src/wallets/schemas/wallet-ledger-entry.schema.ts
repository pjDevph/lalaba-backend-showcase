import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum WalletLedgerEntryType {
  TOP_UP = 'top_up',
  FEE_CONSUMPTION = 'fee_consumption',
  // Credit back of a fee the provider fronted at pickup on an order the
  // customer then abandoned without ever paying (§14 deferred settlement).
  // Not a withdrawal and not a top-up: the platform earned nothing on an order
  // that produced no revenue, so it returns what it took. Only the abandonment
  // path writes these.
  FEE_REVERSAL = 'fee_reversal',
  // A support/admin-entered correction — the one ledgered path that isn't
  // driven by a gateway webhook or an order. Always carries a mandatory
  // reason on the admin-audit trail (never on this row — ledger rows never
  // carry an actor, by the same convention every other entry type follows).
  ADMIN_ADJUSTMENT = 'admin_adjustment',
}
registerEnumType(WalletLedgerEntryType, { name: 'WalletLedgerEntryType' });

export type WalletLedgerEntryDocument = WalletLedgerEntry & Document;

// Append-only — every balance change is a row here; Wallet.balanceCentavos
// is a derived running total, never edited directly.
@ObjectType()
@Schema({
  collection: 'wallet_ledger_entries',
  timestamps: { createdAt: true, updatedAt: false },
})
export class WalletLedgerEntry {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'Branch', required: true })
  branchId!: string;

  @Field(() => WalletLedgerEntryType)
  @Prop({ required: true, enum: WalletLedgerEntryType })
  type!: WalletLedgerEntryType;

  // Positive for top-up and fee reversal, negative for fee consumption.
  @Field(() => Int)
  @Prop({ required: true })
  amountCentavos!: number;

  @Field(() => Int)
  @Prop({ required: true })
  balanceAfterCentavos!: number;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  orderId?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  xenditReference?: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const WalletLedgerEntrySchema =
  SchemaFactory.createForClass(WalletLedgerEntry);
WalletLedgerEntrySchema.index({ branchId: 1, createdAt: -1 });
// Idempotency by DB constraint (RISK-P0-003): at most ONE credit row per
// (branchId, xenditReference), enforced by Mongo itself so two concurrent
// webhook deliveries cannot both insert — the loser gets E11000, which the
// service treats as "already posted". Partial: fee-consumption rows have
// xenditReference: null and must not collide with each other.
WalletLedgerEntrySchema.index(
  { branchId: 1, xenditReference: 1 },
  {
    unique: true,
    partialFilterExpression: { xenditReference: { $type: 'string' } },
  },
);
