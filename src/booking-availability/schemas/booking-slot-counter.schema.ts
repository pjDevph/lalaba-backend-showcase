import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BookingSlotCounterDocument = BookingSlotCounter & Document;

/**
 * Per-provider, per-date, per-slot booking serializer — the same technique
 * DailyCapCounter (online-orders/schemas/daily-cap-counter.schema.ts) uses for
 * the acceptance cap, applied to booking-time slot capacity.
 *
 * NOT the source of truth for how full a slot is. The real count is always
 * recomputed from `online_orders` inside the create transaction. This document
 * exists so two concurrent createOrder transactions for the same
 * branch+date+slot $inc the SAME row and therefore write-conflict: MongoDB
 * aborts one, `withTransaction` retries it, and the retry re-counts with the
 * winner's order now visible. Without it, two customers can both read
 * "2 of 3 booked" and both commit, overfilling the slot.
 *
 * Self-healing: because admission is decided by the count query and not by this
 * number, a cancelled order frees its slot with no compensating decrement.
 */
@Schema({ collection: 'booking_slot_counters', timestamps: true })
export class BookingSlotCounter {
  @Prop({ type: String, required: true })
  branchId!: string;

  /** PH-local calendar date, 'YYYY-MM-DD'. */
  @Prop({ type: String, required: true })
  date!: string;

  /** Slot start, 'HH:MM' PH-local — identifies the window within the day. */
  @Prop({ type: String, required: true })
  slotStart!: string;

  @Prop({ type: Number, default: 0 })
  bookedCount!: number;
}

export const BookingSlotCounterSchema =
  SchemaFactory.createForClass(BookingSlotCounter);

BookingSlotCounterSchema.index(
  { branchId: 1, date: 1, slotStart: 1 },
  { unique: true },
);
