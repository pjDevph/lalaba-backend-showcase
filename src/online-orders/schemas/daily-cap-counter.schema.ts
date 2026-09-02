import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DailyCapCounterDocument = DailyCapCounter & Document;

/**
 * Per-branch, per-day acceptance serializer for the washer daily cap
 * (GAP-H-013). Not the source of truth for the cap count — the real count is
 * always recomputed from `online_orders` inside the acceptance transaction.
 * This doc exists purely so two concurrent acceptOrder transactions for the
 * same branch+day $inc the SAME document and therefore write-conflict: MongoDB
 * aborts one, `withTransaction` retries it, and the retry re-counts with the
 * winner's order now visible — turning the old count-then-write race into a
 * serialized check. Self-heals across cancellations because the count query,
 * not this counter, decides admission.
 */
@Schema({ collection: 'online_order_daily_cap_counters', timestamps: true })
export class DailyCapCounter {
  @Prop({ type: String, required: true })
  branchId!: string;

  /** PH-local calendar day, e.g. '2026-08-12'. */
  @Prop({ type: String, required: true })
  dayKey!: string;

  @Prop({ type: Number, default: 0 })
  acceptedCount!: number;
}

export const DailyCapCounterSchema =
  SchemaFactory.createForClass(DailyCapCounter);
DailyCapCounterSchema.index({ branchId: 1, dayKey: 1 }, { unique: true });
