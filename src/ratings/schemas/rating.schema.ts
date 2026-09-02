import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

export type RatingDocument = Rating & Document;

// All five dimensions are captured together on one screen — never partial
// (§ratings). "Delivery" is the shop's delivery experience, not a personal
// courier scorecard; staff/courier performance stays internal.
@ObjectType()
@Schema({ _id: false })
export class RatingScores {
  @Field(() => Int) @Prop({ type: Number, required: true }) quality!: number;
  @Field(() => Int) @Prop({ type: Number, required: true }) speed!: number;
  @Field(() => Int)
  @Prop({ type: Number, required: true })
  valueForMoney!: number;
  @Field(() => Int) @Prop({ type: Number, required: true }) delivery!: number;
  @Field(() => Int)
  @Prop({ type: Number, required: true })
  communication!: number;
}
export const RatingScoresSchema = SchemaFactory.createForClass(RatingScores);

@ObjectType()
@Schema({ _id: false })
export class ProviderResponse {
  @Field() @Prop({ type: String, required: true }) text!: string;
  @Field() @Prop({ type: Date, required: true }) respondedAt!: Date;
}
export const ProviderResponseSchema =
  SchemaFactory.createForClass(ProviderResponse);

@ObjectType()
@Schema({ collection: 'ratings', timestamps: true })
export class Rating {
  @Field(() => ID)
  _id!: string;

  // One rating per completed order (unique index below) — also pins the
  // customer, since an order has exactly one customer.
  @Field()
  @Prop({ type: String, required: true, unique: true })
  orderId!: string;

  @Field()
  @Prop({ type: String, required: true })
  customerUid!: string;

  @Field(() => ProviderType)
  @Prop({ type: String, enum: ProviderType, required: true })
  providerType!: ProviderType;

  @Field()
  @Prop({ type: String, required: true })
  branchId!: string;

  @Field(() => RatingScores)
  @Prop({ type: RatingScoresSchema, required: true })
  scores!: RatingScores;

  // Average of the five dimensions — not a separately-asked question (§ratings).
  @Field(() => Float)
  @Prop({ type: Number, required: true })
  overallScore!: number;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  comment?: string;

  @Field(() => ProviderResponse, { nullable: true })
  @Prop({ type: ProviderResponseSchema, default: null })
  providerResponse?: ProviderResponse;

  // Editable for 48h after submission, then locked.
  @Field()
  @Prop({ type: Date, required: true })
  editableUntil!: Date;

  // Reviews publish immediately; moderation is reactive (§ratings) — these
  // flags never block visibility on their own, only a takedown does.
  @Field()
  @Prop({ default: false })
  isReported!: boolean;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  reportReason?: string;

  @Field()
  @Prop({ default: false })
  isRemoved!: boolean;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  removalReason?: string;

  // Why a takedown was reversed. Kept alongside removalReason rather than
  // replacing it: both decisions are part of the record, and erasing the
  // first would leave a restored review looking like it was never touched.
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  restoredReason?: string;

  // Set when a report was reviewed and the review left up. Distinct from
  // never-reported: it is the difference between "nobody has looked" and
  // "somebody looked and it was fine".
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  reportDismissedReason?: string;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  reportDismissedAt?: Date | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const RatingSchema = SchemaFactory.createForClass(Rating);
