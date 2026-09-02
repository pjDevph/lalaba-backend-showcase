import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  BookingWindow,
  BookingWindowSchema,
  DayFulfillment,
  DayFulfillmentSchema,
} from './booking-availability-config.schema';

/**
 * §11 — one calendar date that does not follow the weekly rules.
 *
 * Weekly rules alone can't say "closed for Ninoy Aquino Day", "10 AM–4 PM this
 * Saturday only", or "max 8 bookings on the 2nd". An override replaces exactly
 * the fields it sets and inherits the rest from the weekday it lands on, so
 * "reduced capacity" doesn't require restating the hours.
 *
 * `null` on a number here means "inherit the weekday's value" — the same
 * convention DayBookingConfig uses. `isClosed` is the one non-null-able
 * decision because a closure has to be unambiguous.
 */

export type BookingDateOverrideDocument = BookingDateOverride & Document;

@ObjectType()
@Schema({ collection: 'booking_date_overrides', timestamps: true })
export class BookingDateOverride {
  @Field(() => ID)
  _id!: string;

  @Field(() => ID)
  @Prop({ type: String, required: true })
  branchId!: string;

  /** PH-local calendar date, 'YYYY-MM-DD'. */
  @Field()
  @Prop({ type: String, required: true })
  date!: string;

  /** Shown to the provider only — e.g. "Ninoy Aquino Day". */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null, trim: true })
  label?: string | null;

  @Field()
  @Prop({ default: false })
  isClosed!: boolean;

  /** Empty = inherit the weekday's windows. */
  @Field(() => [BookingWindow])
  @Prop({ type: [BookingWindowSchema], default: [] })
  windows!: BookingWindow[];

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  dailyBookingLimit?: number | null;

  /** Null = inherit the weekday's fulfillment availability. */
  @Field(() => DayFulfillment, { nullable: true })
  @Prop({ type: DayFulfillmentSchema, default: null })
  fulfillment?: DayFulfillment | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  updatedBy?: string | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BookingDateOverrideSchema =
  SchemaFactory.createForClass(BookingDateOverride);

// One override per provider per date — an upsert, never a growing pile of
// contradictory rows for the same day.
BookingDateOverrideSchema.index({ branchId: 1, date: 1 }, { unique: true });
