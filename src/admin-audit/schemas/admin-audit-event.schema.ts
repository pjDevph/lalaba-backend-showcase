import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

/**
 * Everything a back-office account can do that changes the platform.
 *
 * One flat enum rather than per-module ones: an auditor's question is "what
 * did this admin do on Tuesday", which cannot be answered from five separate
 * collections with five separate shapes.
 *
 * KYC keeps its own `kyc_audit_events` collection. That trail is
 * document-level and far richer (per-file claims, evidence URL issuance), and
 * folding it in here would either flatten detail the reviewers rely on or
 * bloat this schema with KYC-only fields. The panel reads both.
 */
export enum AdminAuditAction {
  // Provider lifecycle
  PROVIDER_SUSPENDED = 'PROVIDER_SUSPENDED',
  PROVIDER_REACTIVATED = 'PROVIDER_REACTIVATED',
  PROVIDER_CAP_CHANGED = 'PROVIDER_CAP_CHANGED',

  // Accounts
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
  ACCOUNT_REACTIVATED = 'ACCOUNT_REACTIVATED',
  ADMIN_INVITED = 'ADMIN_INVITED',
  /** Force logout — every session for an account ended by an admin. */
  SESSIONS_REVOKED = 'SESSIONS_REVOKED',
  /**
   * The single most sensitive action in the panel: an admin minted a
   * credential to sign in as this account. See DirectoryResolver.impersonateUser
   * for why this is the one action recorded BEFORE it happens rather than after.
   */
  IMPERSONATION_STARTED = 'IMPERSONATION_STARTED',

  // Courier
  COURIER_SELFIE_REVOKED = 'COURIER_SELFIE_REVOKED',

  // Reviews
  REVIEW_REMOVED = 'REVIEW_REMOVED',
  REVIEW_RESTORED = 'REVIEW_RESTORED',

  // Orders
  ORDER_STATUS_OVERRIDDEN = 'ORDER_STATUS_OVERRIDDEN',
  ORDER_REINSTATED = 'ORDER_REINSTATED',

  // Outbound messaging — the widest blast radius in the panel.
  BROADCAST_SENT = 'BROADCAST_SENT',

  // Platform rules
  PLATFORM_FEE_PUBLISHED = 'PLATFORM_FEE_PUBLISHED',
  PLATFORM_FEE_DEACTIVATED = 'PLATFORM_FEE_DEACTIVATED',
  MAINTENANCE_MODE_CHANGED = 'MAINTENANCE_MODE_CHANGED',
  BOOKING_POLICY_PUBLISHED = 'BOOKING_POLICY_PUBLISHED',
  WASHER_SERVICE_CHANGED = 'WASHER_SERVICE_CHANGED',

  // Promo codes
  PROMO_CREATED = 'PROMO_CREATED',
  PROMO_UPDATED = 'PROMO_UPDATED',
  PROMO_ACTIVATED = 'PROMO_ACTIVATED',
  PROMO_DEACTIVATED = 'PROMO_DEACTIVATED',

  // Popup campaigns. Separate from the PROMO_* actions above: a campaign
  // decides what a person SEES and a promo decides what they are owed, and an
  // audit trail that blurs the two cannot answer "who changed the discount".
  CAMPAIGN_CREATED = 'CAMPAIGN_CREATED',
  CAMPAIGN_UPDATED = 'CAMPAIGN_UPDATED',
  /** An admin recorded a redemption by hand — there is no live checkout flow yet. */
  PROMO_REDEEMED = 'PROMO_REDEEMED',

  // Marketing website content (FAQ, service areas, promo banners)
  SITE_CONTENT_UPDATED = 'SITE_CONTENT_UPDATED',

  // Wallets — a manual correction outside the gateway/order-driven paths.
  WALLET_ADJUSTED = 'WALLET_ADJUSTED',
}
registerEnumType(AdminAuditAction, { name: 'AdminAuditAction' });

/** What the action was done TO, so the trail can be read per-entity. */
export enum AdminAuditTargetType {
  USER = 'USER',
  PROVIDER = 'PROVIDER',
  ORDER = 'ORDER',
  COURIER_SELFIE = 'COURIER_SELFIE',
  REVIEW = 'REVIEW',
  BROADCAST = 'BROADCAST',
  PROMO_CODE = 'PROMO_CODE',
  CAMPAIGN = 'CAMPAIGN',
  PLATFORM_CONFIG = 'PLATFORM_CONFIG',
  SITE_CONTENT = 'SITE_CONTENT',
  WALLET = 'WALLET',
}
registerEnumType(AdminAuditTargetType, { name: 'AdminAuditTargetType' });

export type AdminAuditEventDocument = AdminAuditEvent & Document;

/**
 * Append-only trail of back-office actions.
 *
 * APPEND-ONLY IS THE POINT: AdminAuditService only ever create()s here. No
 * update or delete path exists and none may be added — a trail an admin can
 * edit answers no question worth asking. There is deliberately no mutation
 * over GraphQL either, only the writes the services make for themselves.
 *
 * Before this existed, `deactivateUser(uid)` took a uid and nothing else,
 * wrote no record, and could not say who did it or why.
 */
@ObjectType()
@Schema({
  collection: 'admin_audit_events',
  timestamps: { createdAt: 'timestamp', updatedAt: false },
})
export class AdminAuditEvent {
  @Field(() => ID)
  _id!: string;

  @Field(() => AdminAuditAction)
  @Prop({ type: String, enum: AdminAuditAction, required: true, index: true })
  action!: AdminAuditAction;

  @Field()
  @Prop({ type: String, required: true, index: true })
  actorUid!: string;

  /**
   * Denormalised on write, on purpose. An audit trail must still read
   * correctly after the actor's account is renamed or deleted — resolving the
   * name at read time would silently rewrite history.
   */
  @Field()
  @Prop({ type: String, required: true })
  actorName!: string;

  @Field()
  @Prop({ type: String, required: true })
  actorEmail!: string;

  /** roleId at the time of the action, for the same reason as the name. */
  @Field()
  @Prop({ type: String, required: true })
  actorRole!: string;

  @Field(() => AdminAuditTargetType)
  @Prop({ type: String, enum: AdminAuditTargetType, required: true })
  targetType!: AdminAuditTargetType;

  @Field()
  @Prop({ type: String, required: true, index: true })
  targetId!: string;

  /** Denormalised label — same reasoning as actorName. */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  targetLabel?: string;

  /**
   * Structured reason CODE, not prose. The whole point of codes is that
   * "why do we suspend most washers" is answerable without reading free text.
   * Nullable only because a few actions are not decisions about a person
   * (publishing a fee schedule).
   */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  reasonCode?: string;

  /** The admin's free-text note. Colour, never the record itself. */
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  note?: string;

  /**
   * Action-specific detail — the before/after of a cap change, the app a
   * maintenance toggle targeted. Mixed because the shape genuinely differs per
   * action, and forcing a common one would mean logging less than we know.
   *
   * Stored as an object so Mongo can query into it, but NOT exposed directly:
   * a Mixed value has no GraphQL type. The resolver exposes `detailsJson`
   * instead, which is what a panel renders anyway.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  details?: Record<string, unknown>;

  @Field({ nullable: true })
  timestamp?: Date;
}

export const AdminAuditEventSchema =
  SchemaFactory.createForClass(AdminAuditEvent);

AdminAuditEventSchema.index({ timestamp: -1 });
AdminAuditEventSchema.index({ targetType: 1, targetId: 1, timestamp: -1 });
AdminAuditEventSchema.index({ actorUid: 1, timestamp: -1 });
