// LEGACY — RETIRED IN PHASE 2 (GAP-P0-011 + DECISION_REQUIRED-003). This file
// documents the shape of the preserved `washer_earnings` collection only. It
// is intentionally not imported by any module/service/resolver: nothing in
// Phase 2 runtime reads or writes this collection. Money is handled by the
// consumable wallet — there are no washer payouts/withdrawals.
import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum EarningStatus {
  PENDING = 'PENDING',
  RELEASED = 'RELEASED',
  WITHDRAWN = 'WITHDRAWN',
}
registerEnumType(EarningStatus, { name: 'EarningStatus' });

export type WasherEarningDocument = WasherEarning & Document;

@ObjectType()
@Schema({ collection: 'washer_earnings', timestamps: true })
export class WasherEarning {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true })
  washerId!: string;

  @Field()
  @Prop({ type: String, required: true })
  bookingId!: string;

  @Field(() => Float)
  @Prop({ type: Number, required: true })
  grossAmount!: number;

  @Field(() => Float)
  @Prop({ type: Number, required: true })
  platformFee!: number;

  @Field(() => Float)
  @Prop({ type: Number, required: true })
  netAmount!: number;

  @Field(() => EarningStatus)
  @Prop({ type: String, enum: EarningStatus, default: EarningStatus.PENDING })
  status!: EarningStatus;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  holdUntil?: Date;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  releasedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  withdrawnAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  withdrawalRef?: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const WasherEarningSchema = SchemaFactory.createForClass(WasherEarning);
