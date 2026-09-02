import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationReadDocument = NotificationRead & Document;

/**
 * One reader having read one BRANCH notification.
 *
 * Branch notifications are stored once and read by many people — that sharing
 * is the whole point of branch scoping (one row, not one per staff member). It
 * also means read state cannot live on the notification itself: a single
 * `readAt` would let the first staff member to open the feed mark the row read
 * for everyone, and the row would vanish from their colleagues' badges having
 * never been seen.
 *
 * Rows here are only ever written for branch notifications. Direct rows keep
 * their inline `Notification.readAt`, which costs nothing and keeps the common
 * case index-only.
 *
 * Growth is bounded by two things: the TTL below, and the read cursor
 * (notification-read-cursor.schema.ts), which lets "mark all read" collapse an
 * unbounded number of these into one watermark.
 */
@Schema({
  collection: 'notification_reads',
  timestamps: { createdAt: true, updatedAt: false },
})
export class NotificationRead {
  _id!: string;

  @Prop({ type: String, required: true })
  notificationId!: string;

  @Prop({ type: String, required: true })
  uid!: string;

  /** Mirrors the notification's own expiry — a read of a reaped row is noise. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
}

export const NotificationReadSchema =
  SchemaFactory.createForClass(NotificationRead);

/** Unique so a double-tap on "mark read" is a no-op rather than a second row. */
NotificationReadSchema.index({ uid: 1, notificationId: 1 }, { unique: true });

NotificationReadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
