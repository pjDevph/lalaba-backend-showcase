import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { HydratedDocument } from 'mongoose';

// Matches the website's `AudienceId | "all"` exactly.
export enum SiteAnnouncementAudience {
  CUSTOMER = 'customer',
  LAUNDROMAT = 'laundromat',
  HOME_WASHER = 'home-washer',
  ALL = 'all',
}
registerEnumType(SiteAnnouncementAudience, {
  name: 'SiteAnnouncementAudience',
});

export type SiteAnnouncementDocument = HydratedDocument<SiteAnnouncement>;

/**
 * A marketing banner on the public site's promo carousel — content/promos.ts
 * today. Distinct from the `promotions` module's PromoCode: that is a
 * redeemable discount enforced at checkout; this is display copy that MAY
 * mention a code in its text but is never itself validated against an order.
 * An admin publishing one is not creating a working discount.
 *
 * `image` is a URL to an already-hosted asset — there is no upload pipeline
 * here, matching how every other image-bearing admin field in this codebase
 * works today (paste a URL, do not upload a file).
 */
@ObjectType()
@Schema({ collection: 'site_announcements', timestamps: true })
export class SiteAnnouncement {
  @Field(() => ID)
  _id!: string;

  @Field(() => SiteAnnouncementAudience)
  @Prop({
    type: String,
    enum: SiteAnnouncementAudience,
    default: SiteAnnouncementAudience.ALL,
  })
  audience!: SiteAnnouncementAudience;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  eyebrow!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  description!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  promoCode?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  validityText?: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  ctaText!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  ctaUrl!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  image?: string;

  @Field()
  @Prop({ type: Number, default: 0 })
  order!: number;

  @Field()
  @Prop({ type: Boolean, default: true })
  isPublished!: boolean;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const SiteAnnouncementSchema =
  SchemaFactory.createForClass(SiteAnnouncement);
SiteAnnouncementSchema.index({ order: 1 });
