import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ConsentDocument = Consent & Document;

// Append-only record of a single policy acceptance. Never updated after
// creation — a re-consent to a new policy version creates a new row, so the
// full acceptance history is always available, not just the latest.
@ObjectType()
@Schema({
  collection: 'consents',
  timestamps: { createdAt: true, updatedAt: false },
})
export class Consent {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  uid!: string;

  @Field()
  @Prop({ required: true, trim: true })
  policyType!: string; // e.g. 'terms_of_service', 'privacy_policy', 'merchant_agreement'

  @Field()
  @Prop({ required: true, trim: true })
  version!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  locale?: string;

  @Field()
  @Prop({ required: true, trim: true })
  source!: string; // server-stamped context, e.g. 'registration'

  @Field({ nullable: true })
  createdAt?: Date;
}

export const ConsentSchema = SchemaFactory.createForClass(Consent);
ConsentSchema.index({ uid: 1, policyType: 1, version: 1 }, { unique: true });
ConsentSchema.index({ uid: 1, createdAt: -1 });
