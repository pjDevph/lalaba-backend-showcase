import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformFeeConfigDocument = PlatformFeeConfig & Document;

// Admin-configurable, versioned — "changing the fee" creates a NEW record
// rather than editing an existing one, so past orders' snapshots (taken at
// creation, see OnlineOrder.pricing.platformFeePercent) never get rewritten
// by a later rate change (§16). One global rate for now, no per-branch override.
@ObjectType()
@Schema({
  collection: 'platform_fee_configs',
  timestamps: { createdAt: true, updatedAt: false },
})
export class PlatformFeeConfig {
  @Field(() => ID)
  _id!: string;

  @Field(() => Float)
  @Prop({ required: true, min: 0, max: 100 })
  feePercent!: number;

  @Field()
  @Prop({ required: true })
  effectiveFrom!: Date;

  @Field()
  @Prop({ required: true })
  setByUid!: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const PlatformFeeConfigSchema =
  SchemaFactory.createForClass(PlatformFeeConfig);
PlatformFeeConfigSchema.index({ effectiveFrom: -1 });
