import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CampaignImpressionDocument = CampaignImpression & Document;

/**
 * One showing of one campaign to one account, in one period.
 *
 * This table IS the frequency rule. `periodKey` encodes the window the
 * campaign's frequency defines — a date, an ISO week, a login, a launch
 * bucket, or the literal string for "ever" — and a unique index on
 * (campaign, account, period) makes a second showing in the same window
 * impossible rather than merely unlikely. Two requests racing produce one row
 * and one duplicate-key error, not two popups.
 */
@ObjectType()
@Schema({
  collection: 'campaign_impressions',
  timestamps: { createdAt: true, updatedAt: false },
})
export class CampaignImpression {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true, index: true })
  campaignId!: string;

  @Field()
  @Prop({ type: String, required: true, index: true })
  uid!: string;

  /** The role the account held when it was shown — campaigns are targeted by
   *  role, and a person's role can change. */
  @Field()
  @Prop({ type: String, required: true })
  roleId!: string;

  @Field()
  @Prop({ type: String, required: true })
  periodKey!: string;

  @Field()
  @Prop({ type: Date, default: () => new Date() })
  shownAt!: Date;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  clickedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  dismissedAt?: Date | null;

  /**
   * When this row may be swept.
   *
   * Deliberately ABSENT on ONCE_EVER rows: Mongo's TTL monitor ignores
   * documents where the field is missing, and a lifetime impression that
   * expired would quietly make a once-only campaign show again. Everything
   * periodic is disposable once its window has long passed — those rows exist
   * to answer "this week?", not to be a permanent record.
   */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;

  @Field(() => Date, { nullable: true })
  createdAt?: Date;
}

export const CampaignImpressionSchema =
  SchemaFactory.createForClass(CampaignImpression);

/** The frequency rule, enforced by the database rather than by a code path. */
CampaignImpressionSchema.index(
  { campaignId: 1, uid: 1, periodKey: 1 },
  { unique: true },
);

/** The EVERY_APP_OPEN floor reads the most recent impression per account. */
CampaignImpressionSchema.index({ campaignId: 1, uid: 1, shownAt: -1 });

/**
 * TTL sweep. `expireAfterSeconds: 0` means "delete when `expiresAt` passes",
 * and rows with a null/absent `expiresAt` are never touched — which is what
 * keeps ONCE_EVER permanent.
 */
CampaignImpressionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
