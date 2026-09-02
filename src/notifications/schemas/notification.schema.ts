import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  NotificationAudience,
  NotificationCategory,
  NotificationType,
} from '../notification.enums';

/** How long a notification stays in the feed before the TTL index reaps it. */
export const NOTIFICATION_RETENTION_DAYS = 90;

export type NotificationDocument = Notification & Document;

/**
 * The structured payload a client needs to route a notification somewhere.
 *
 * Every field is nullable and a string: this is a lookup key bag, not a
 * snapshot of the referenced entity. It exists as a typed ObjectType rather
 * than the JSON scalar (src/scalars/json.scalar.ts) because JSON lands on the
 * clients as `any`, and both apps enforce an any-free rule. A typed shape also
 * lets the apps' validate:schema step check the selection set.
 */
@ObjectType()
export class NotificationData {
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  orderId?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  orderNumber?: string | null;

  /** An OrderStatus value, as its SDL name. Untyped here on purpose — the feed
   * must not import the order module, and a stale copy of the enum would be
   * worse than a string. */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  status?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  branchId?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  providerId?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  deviceId?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  staffId?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  conversationId?: string | null;
}

/**
 * One notification, as stored.
 *
 * Not exposed to GraphQL directly — the resolver returns NotificationItem
 * (models/notification-item.model.ts), which adds a per-caller `isRead` that
 * this document deliberately cannot carry for branch rows.
 *
 * `title`/`body` are a DENORMALIZED copy of what was pushed, never re-rendered
 * from live data. A feed that regenerates its own text rewrites history: an
 * order that later gets cancelled would retroactively claim it was always
 * cancelled, and the notification the user actually saw on their lock screen
 * would no longer exist anywhere.
 */
@Schema({ collection: 'notifications', timestamps: true })
export class Notification {
  _id!: string;

  @Prop({
    type: String,
    enum: NotificationAudience,
    required: true,
  })
  audience!: NotificationAudience;

  /** Set iff audience=USER. */
  @Prop({ type: String, ref: 'User', default: null })
  uid?: string | null;

  /** Set iff audience=BRANCH. */
  @Prop({ type: String, ref: 'Branch', default: null })
  branchId?: string | null;

  /**
   * The branch owner's uid, denormalized off Branch.uid at write time.
   * Lets an owner's feed resolve their branch rows from one index instead of
   * joining Branch on every page. Only meaningful when audience=BRANCH.
   */
  @Prop({ type: String, default: null })
  merchantId?: string | null;

  /**
   * A permissionName from PERMISSION_CATALOGUE. null means every branch member
   * sees the row.
   *
   * This is a DATA field, so PermissionsGuard never validates it — a typo here
   * fails silently and permanently (the row is invisible forever, with no
   * error anywhere). order-notifications.map.spec.ts asserts every name used by
   * the order mapping exists in the catalogue; anything else writing this field
   * needs the same guard.
   */
  @Prop({ type: String, default: null })
  requiredPermission?: string | null;

  @Prop({ type: String, enum: NotificationType, required: true })
  type!: NotificationType;

  @Prop({ type: String, enum: NotificationCategory, required: true })
  category!: NotificationCategory;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, required: true })
  body!: string;

  @Prop({ type: NotificationData, default: () => ({}) })
  data!: NotificationData;

  /**
   * An in-app route, if one can be named here.
   *
   * Left null by every current sender, deliberately. One string cannot address
   * four apps with four different route trees — the values that used to be set
   * ('/settings/devices', '/verification') were routes none of them had, and
   * the merchant inbox pushed them straight into the router and dead-ended on
   * "Unmatched Route". Clients route from `type` and `data`, which they can
   * resolve against their own routes.
   *
   * Kept on the schema for a future sender that genuinely owns a client's
   * routing. Anything writing it must be sure the value exists in the app that
   * will receive it.
   */
  @Prop({ type: String, default: null })
  deepLink?: string | null;

  /**
   * Idempotency key. Uniquely identifies the real-world event this row
   * reports, so a retried write is rejected by the index rather than
   * duplicated into someone's feed.
   *
   * Order rows use `${orderEventId}:${recipientKey}` — the sweeper can then be
   * safely re-run over events it may have already processed.
   */
  @Prop({ type: String, default: null })
  sourceEventId?: string | null;

  /**
   * Only meaningful when audience=USER. Branch rows have many readers and
   * therefore no single read state — see notification-read.schema.ts.
   */
  @Prop({ type: Date, default: null })
  readAt?: Date | null;

  /**
   * When the push actually went out. Persisted-but-never-pushed is a real and
   * silent state (no tokens, FCM down, push:false) and this is the only way to
   * tell it apart from a delivered one after the fact.
   */
  @Prop({ type: Date, default: null })
  pushSentAt?: Date | null;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// --- Indexes -----------------------------------------------------------------
//
// Partial rather than sparse throughout, for the same reason as
// OnlineOrder.orderNumber and WalletLedgerEntry.xenditReference: a plain unique
// index treats every document that lacks the field as sharing one value, so the
// second such document collides.

/** Feed page, direct rows. */
NotificationSchema.index(
  { uid: 1, createdAt: -1 },
  { partialFilterExpression: { uid: { $type: 'string' } } },
);

/** Feed page, branch rows. */
NotificationSchema.index(
  { branchId: 1, createdAt: -1 },
  { partialFilterExpression: { branchId: { $type: 'string' } } },
);

/** Unread count for direct rows — covered, so the badge never touches a doc. */
NotificationSchema.index({ uid: 1, readAt: 1, createdAt: -1 });

/** Idempotency. See sourceEventId above. */
NotificationSchema.index(
  { sourceEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceEventId: { $type: 'string' } },
  },
);

/** Retention. */
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
