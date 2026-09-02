import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * How often one account may see a campaign.
 *
 * Every value maps to a period key (see `periodKeyFor`), and a unique index on
 * campaign + account + period is what actually enforces the rule. Frequency is
 * therefore a description of how to bucket time, not a flag someone has to
 * remember to honour at the call site.
 */
export enum CampaignFrequency {
  /** Once per account, for the life of the campaign. */
  ONCE_EVER = 'ONCE_EVER',
  /** Once per sign-in. */
  EVERY_LOGIN = 'EVERY_LOGIN',
  /** Once per app launch, floored to a minimum interval server-side. */
  EVERY_APP_OPEN = 'EVERY_APP_OPEN',
  /** Once per Manila calendar day. */
  DAILY = 'DAILY',
  /** Once per Manila ISO week. */
  WEEKLY = 'WEEKLY',
}
registerEnumType(CampaignFrequency, { name: 'CampaignFrequency' });

/** What tapping the image does. The campaign never calculates money — at most
 *  it points at a promo the promotions engine already owns. */
export enum CampaignActionType {
  NONE = 'NONE',
  PROMO = 'PROMO',
  DEEP_LINK = 'DEEP_LINK',
}
registerEnumType(CampaignActionType, { name: 'CampaignActionType' });

export enum CampaignStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
}
registerEnumType(CampaignStatus, { name: 'CampaignStatus' });

export type CampaignDocument = Campaign & Document;

/**
 * A full-screen image shown once the app has an authenticated identity.
 *
 * Deliberately separate from PromoCode: this decides what a person SEES, and
 * the promotions engine decides what they are financially entitled to. A
 * campaign can advertise a promo, but it can never compute a discount — so a
 * mistake here is a wrong picture, never a wrong price.
 */
@ObjectType()
@Schema({ collection: 'campaigns', timestamps: true })
export class Campaign {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  /**
   * Who sees it, in the same role vocabulary broadcasts and promo codes
   * already use. There is no second audience concept: "All partners" is a
   * preset in the admin UI that writes [merchant, washer], not a stored value.
   *
   * Merchant and washer are distinct roles here, so a campaign can target one
   * without the other even though both live in the partner app. Staff and
   * couriers do not inherit a merchant's campaigns — they are separate roles
   * and must be named explicitly.
   */
  @Field(() => [String])
  @Prop({ type: [String], required: true })
  targetRoleIds!: string[];

  @Field()
  @Prop({ type: String, required: true })
  imageUrl!: string;

  /** Storage path, kept so the object can be cleaned up if the campaign is
   *  deleted. Uploads go through the existing media pipeline.
   *  Explicit type: `string | null` has no reflectable design type. */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  imagePath?: string | null;

  /** Read out by screen readers in place of the image. */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  altText?: string | null;

  @Field(() => CampaignFrequency)
  @Prop({ type: String, enum: CampaignFrequency, required: true })
  frequency!: CampaignFrequency;

  @Field(() => CampaignActionType)
  @Prop({
    type: String,
    enum: CampaignActionType,
    default: CampaignActionType.NONE,
  })
  actionType!: CampaignActionType;

  /** Set when actionType is PROMO. The campaign shows the code; the
   *  promotions engine still decides whether it may be used. */
  @Field(() => ID, { nullable: true })
  @Prop({ type: String, default: null })
  promoId?: string | null;

  /** Set when actionType is DEEP_LINK. An in-app route, never an external URL
   *  — an admin-supplied external link would be an open redirect out of the
   *  app, and nothing in the product needs one. */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  deepLink?: string | null;

  @Field()
  @Prop({ type: Date, required: true })
  startsAt!: Date;

  /** Null = runs until paused or archived. */
  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  endsAt?: Date | null;

  /**
   * Highest wins when several campaigns are eligible at once.
   *
   * Only ever ONE campaign is returned per request. Opening the app to four
   * modals in a row is the single most reliable way to make people stop
   * opening the app.
   */
  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  priority!: number;

  @Field(() => CampaignStatus)
  @Prop({ type: String, enum: CampaignStatus, default: CampaignStatus.DRAFT })
  status!: CampaignStatus;

  @Field()
  @Prop({ type: String, required: true })
  createdByUid!: string;

  @Field()
  @Prop({ type: String, required: true })
  createdByName!: string;

  @Field(() => Date, { nullable: true })
  createdAt?: Date;

  @Field(() => Date, { nullable: true })
  updatedAt?: Date;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);

// The eligibility query: active campaigns for my role, in window, best first.
CampaignSchema.index({ status: 1, targetRoleIds: 1, startsAt: 1, endsAt: 1 });
CampaignSchema.index({ priority: -1, createdAt: -1 });
