import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

/**
 * CAMPAIGNS — a temporary, platform-wide change to what providers are entitled
 * to, expressed as ONE record.
 *
 * "Laundry Week doubles everyone's capacity" is a single row with a ×2
 * multiplier. It is not 806,696 provider updates that then have to be undone on
 * the 28th — which is the version of this that cannot be rolled back cleanly,
 * because by then some of those providers will have changed tier.
 *
 * Modifiers are relative on purpose. Storing "capacity becomes 40" would need a
 * separate campaign per milestone to avoid flattening Starter and Pro onto the
 * same number; a multiplier scales the whole ladder from one value.
 */

export enum CampaignModifierMode {
  /** Ignore the earned value; use this number outright. */
  REPLACE = 'replace',
  /** Earned value × factor, rounded down. */
  MULTIPLY = 'multiply',
  /** Earned value + amount. */
  INCREASE_BY = 'increase_by',
}
registerEnumType(CampaignModifierMode, { name: 'CampaignModifierMode' });

export enum CampaignScope {
  EVERYONE = 'everyone',
  PROVIDER_TYPE = 'provider_type',
  MILESTONE = 'milestone',
}
registerEnumType(CampaignScope, { name: 'CampaignScope' });

@ObjectType()
@Schema({ _id: false })
export class CampaignModifier {
  @Field(() => CampaignModifierMode)
  @Prop({ type: String, enum: CampaignModifierMode, required: true })
  mode!: CampaignModifierMode;

  /** A factor under MULTIPLY, otherwise a whole number of units. */
  @Field(() => Float)
  @Prop({ type: Number, required: true, min: 0 })
  value!: number;
}
export const CampaignModifierSchema =
  SchemaFactory.createForClass(CampaignModifier);

@ObjectType()
@Schema({ _id: false })
export class CampaignTargeting {
  @Field(() => CampaignScope)
  @Prop({ type: String, enum: CampaignScope, default: CampaignScope.EVERYONE })
  scope!: CampaignScope;

  /** Set only under PROVIDER_TYPE. */
  @Field(() => ProviderType, { nullable: true })
  @Prop({ type: String, enum: ProviderType, default: null })
  providerType?: ProviderType | null;

  /** Milestone keys, set only under MILESTONE. */
  @Field(() => [String])
  @Prop({ type: [String], default: [] })
  milestoneKeys!: string[];
}
export const CampaignTargetingSchema =
  SchemaFactory.createForClass(CampaignTargeting);

export type BookingCampaignDocument = BookingCampaign & Document;

@ObjectType()
@Schema({ collection: 'booking_campaigns', timestamps: true })
export class BookingCampaign {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null, trim: true })
  description?: string | null;

  /** PH-local 'YYYY-MM-DD', both inclusive. */
  @Field()
  @Prop({ type: String, required: true })
  startDate!: string;

  @Field()
  @Prop({ type: String, required: true })
  endDate!: string;

  /**
   * An admin's off switch, distinct from the date window. A campaign can be
   * built and reviewed days ahead while disabled, and killed mid-run without
   * destroying the record or rewriting its dates.
   */
  @Field()
  @Prop({ default: true })
  isEnabled!: boolean;

  @Field(() => CampaignTargeting)
  @Prop({ type: CampaignTargetingSchema, default: () => ({}) })
  targeting!: CampaignTargeting;

  // Null = leave that entitlement alone. A campaign that only extends the
  // advance window should not have to restate capacity.
  @Field(() => CampaignModifier, { nullable: true })
  @Prop({ type: CampaignModifierSchema, default: null })
  dailyCapacity?: CampaignModifier | null;

  @Field(() => CampaignModifier, { nullable: true })
  @Prop({ type: CampaignModifierSchema, default: null })
  advanceBookingDays?: CampaignModifier | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  createdBy?: string | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BookingCampaignSchema =
  SchemaFactory.createForClass(BookingCampaign);
// Every entitlement read asks "which campaigns cover today", so the window is
// the index, not the name.
BookingCampaignSchema.index({ isEnabled: 1, startDate: 1, endDate: 1 });
