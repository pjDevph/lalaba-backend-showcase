import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationReadCursorDocument = NotificationReadCursor & Document;

/**
 * A "everything older than this is read" watermark, one row per account.
 *
 * Without it, "mark all read" on a busy branch would write one NotificationRead
 * per visible row, every time — an unbounded write for a gesture users make
 * casually and often. With it, that gesture is a single upsert, and the read
 * rows it supersedes can be deleted outright.
 *
 * It also bounds every unread query: nothing at or before the watermark can be
 * unread, so the aggregation never scans past it however much history exists.
 */
@Schema({ collection: 'notification_read_cursors', timestamps: true })
export class NotificationReadCursor {
  _id!: string;

  @Prop({ type: String, required: true })
  uid!: string;

  /**
   * Notifications created at or before this instant are read by this account,
   * whatever their audience and whether or not a NotificationRead exists.
   */
  @Prop({ type: Date, required: true })
  readAllBefore!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationReadCursorSchema = SchemaFactory.createForClass(
  NotificationReadCursor,
);

NotificationReadCursorSchema.index({ uid: 1 }, { unique: true });
