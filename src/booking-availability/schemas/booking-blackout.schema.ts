import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * §12 — a closed date RANGE ("equipment maintenance, Aug 20–22").
 *
 * Kept separate from BookingDateOverride rather than expanded into one override
 * per date: a two-week closure would otherwise write fourteen rows that have to
 * be deleted together, and the provider's reason would be duplicated across all
 * of them. A blackout is one row the provider can lift in one action.
 *
 * `reason` is internal. The customer app only ever learns the date is
 * unavailable — telling a customer the washer's machine broke is the
 * provider's business, not the platform's disclosure to make.
 */

export type BookingBlackoutDocument = BookingBlackout & Document;

@ObjectType()
@Schema({ collection: 'booking_blackouts', timestamps: true })
export class BookingBlackout {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true })
  branchId!: string;

  /** PH-local 'YYYY-MM-DD', inclusive. */
  @Field()
  @Prop({ type: String, required: true })
  startDate!: string;

  /** PH-local 'YYYY-MM-DD', inclusive. Equal to startDate for a single day. */
  @Field()
  @Prop({ type: String, required: true })
  endDate!: string;

  /** Internal only — never surfaced to customers. */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null, trim: true })
  reason?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  createdBy?: string | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BookingBlackoutSchema =
  SchemaFactory.createForClass(BookingBlackout);

// Range lookups are always "does any blackout cover this date for this branch",
// so branchId + endDate carries the query and startDate filters in memory.
BookingBlackoutSchema.index({ branchId: 1, endDate: 1 });
