// LEGACY — RETIRED IN PHASE 2 (GAP-P0-011). This file documents the shape of
// the preserved `washer_bookings` collection only. It is intentionally not
// imported by any module/service/resolver: nothing in Phase 2 runtime reads
// or writes this collection. Order work flows through `online_orders`.
import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum BookingStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}
registerEnumType(BookingStatus, { name: 'BookingStatus' });

@ObjectType()
export class BookingItem {
  @Field({ nullable: true })
  serviceLabel?: string;

  @Field(() => Float, { nullable: true })
  weightKg?: number;

  @Field(() => Float, { nullable: true })
  subtotal?: number;
}

export type WasherBookingDocument = WasherBooking & Document;

@ObjectType()
@Schema({ collection: 'washer_bookings', timestamps: true })
export class WasherBooking {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true })
  washerId!: string;

  @Field()
  @Prop({ type: String, required: true })
  customerId!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  customerName?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  customerPhone?: string;

  @Field()
  @Prop({ type: String, required: true })
  bookingDate!: string;

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  slotNumber?: number;

  @Field(() => [BookingItem])
  @Prop({ type: [Object], default: [] })
  items!: Record<string, any>[];

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null })
  totalWeightKg?: number;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null })
  totalAmount?: number;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null })
  platformFee?: number;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null })
  washerPayout?: number;

  @Field(() => BookingStatus)
  @Prop({ type: String, enum: BookingStatus, default: BookingStatus.PENDING })
  status!: BookingStatus;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  pickupAddress?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  deliveryAddress?: string;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  confirmedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  startedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  completedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  cancelledAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  cancellationReason?: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const WasherBookingSchema = SchemaFactory.createForClass(WasherBooking);
