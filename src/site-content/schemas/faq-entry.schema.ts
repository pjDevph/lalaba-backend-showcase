import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { HydratedDocument } from 'mongoose';

// Matches types/site.ts's FaqItem.category on the website exactly — the
// public endpoint returns this string as-is, so the site's existing
// category grouping keeps working unchanged.
export enum FaqCategory {
  GENERAL_AND_CUSTOMER = 'General & Customer',
  PARTNERS = 'Partners',
}
registerEnumType(FaqCategory, { name: 'FaqCategory' });

export type FaqEntryDocument = HydratedDocument<FaqEntry>;

@ObjectType()
@Schema({ collection: 'site_faq_entries', timestamps: true })
export class FaqEntry {
  @Field(() => ID)
  _id!: string;

  @Field(() => FaqCategory)
  @Prop({ type: String, enum: FaqCategory, required: true })
  category!: FaqCategory;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  question!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  answer!: string;

  // Ascending sort within a category. No drag-reorder UI — an admin editing
  // this rarely enough to need one is a good sign the FAQ is being curated,
  // not churned.
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

export const FaqEntrySchema = SchemaFactory.createForClass(FaqEntry);
FaqEntrySchema.index({ category: 1, order: 1 });
