import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * MILESTONES — what a provider has EARNED, evaluated, never assigned.
 *
 * A milestone is a rule, not a badge stamped onto a provider. Nothing writes
 * "tier: growth" to a washer's document; her tier is whichever active milestone
 * she currently satisfies with the highest rank. That means a milestone's
 * thresholds can be edited and every provider's tier re-evaluates on the next
 * read — no backfill, no migration, no drift between the rule and the label.
 *
 * Ranked rather than ordered by threshold because eligibility is multi-signal
 * (orders AND rating AND cancellation rate): two milestones can each be
 * satisfiable without either implying the other, so "highest" has to be an
 * explicit business decision.
 *
 * Home washers only — see BookingPolicy's header for why laundromats have no
 * capacity ladder.
 */

/**
 * A null threshold means "not part of this milestone's eligibility", which is
 * different from zero. `minRating: 0` would still exclude an unrated provider
 * under a `>=` test on a null average, so the two must not collapse.
 */
@ObjectType()
@Schema({ _id: false })
export class MilestoneEligibility {
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  minCompletedOrders?: number | null;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0, max: 5 })
  minRating?: number | null;

  /** Percent, 0–100. */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0, max: 100 })
  maxCancellationRatePercent?: number | null;

  @Field()
  @Prop({ default: false })
  requireVerified!: boolean;

  /** Not suspended, wallet in good standing. */
  @Field()
  @Prop({ default: false })
  requireGoodStanding!: boolean;
}
export const MilestoneEligibilitySchema =
  SchemaFactory.createForClass(MilestoneEligibility);

@ObjectType()
@Schema({ _id: false })
export class MilestoneEntitlements {
  @Field(() => Int)
  @Prop({ type: Number, required: true, min: 0 })
  dailyCapacity!: number;

  @Field(() => Int)
  @Prop({ type: Number, required: true, min: 0 })
  advanceBookingDays!: number;

  /** Reserved for surfacing a provider higher in discovery. Not yet consumed. */
  @Field()
  @Prop({ default: false })
  priorityBooking!: boolean;
}
export const MilestoneEntitlementsSchema = SchemaFactory.createForClass(
  MilestoneEntitlements,
);

export type BookingMilestoneDocument = BookingMilestone & Document;

@ObjectType()
@Schema({ collection: 'booking_milestones', timestamps: true })
export class BookingMilestone {
  @Field(() => ID)
  _id!: string;

  /** Stable slug — campaigns target these, so renaming must not break them. */
  @Field()
  @Prop({ type: String, required: true, unique: true, trim: true })
  key!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null, trim: true })
  description?: string | null;

  /**
   * Higher wins when a provider satisfies several. The starter tier is rank 0
   * and normally has no thresholds at all.
   */
  @Field(() => Int)
  @Prop({ type: Number, required: true, default: 0 })
  rank!: number;

  /**
   * The floor every provider gets, including a brand-new one who satisfies
   * nothing. Exactly one milestone should carry this.
   */
  @Field()
  @Prop({ default: false })
  isDefault!: boolean;

  @Field()
  @Prop({ default: true })
  isActive!: boolean;

  @Field(() => MilestoneEligibility)
  @Prop({ type: MilestoneEligibilitySchema, default: () => ({}) })
  eligibility!: MilestoneEligibility;

  @Field(() => MilestoneEntitlements)
  @Prop({ type: MilestoneEntitlementsSchema, required: true })
  entitlements!: MilestoneEntitlements;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  updatedBy?: string | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BookingMilestoneSchema =
  SchemaFactory.createForClass(BookingMilestone);
BookingMilestoneSchema.index({ rank: -1 });
