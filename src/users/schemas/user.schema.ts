import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { registerEnumType } from '@nestjs/graphql';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { HomeAddress, HomeAddressSchema } from './address.schema';

export type UserDocument = User & Document;

// Self-service deletion lifecycle state. Deliberately separate from the
// admin-driven isActive/isArchived toggles: ACTIVE → DELETION_PENDING (grace
// period, reversible) → DELETED (PII erased, irreversible).
export enum AccountStatus {
  ACTIVE = 'active',
  DELETION_PENDING = 'deletion_pending',
  DELETED = 'deleted',
}
registerEnumType(AccountStatus, { name: 'AccountStatus' });

// Per-branch permission grants — the canonical grant store for staff.
//
// A staff member may work several branches and hold different access at each:
// a counter hand in Makati who only restocks in BGC. `permissionIds` here is
// the grant for THAT branch alone, and `PermissionsGuard` reads exactly one of
// these entries — the one matching the branch the caller's approved device is
// pinned to.
//
// `_id: false` because a generated subdocument id would serialize into the
// cached user document and the GraphQL type for no reason.
@Schema({ _id: false })
export class BranchAccess {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  })
  branchId!: string;

  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: 'Permission',
    default: [],
  })
  permissionIds!: string[];
}

export const BranchAccessSchema = SchemaFactory.createForClass(BranchAccess);

@Schema({ collection: 'users', timestamps: true })
export class User {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Role', required: true })
  role!: string;

  @Prop({ required: true, unique: true })
  email!: string;

  @Prop({ required: true })
  firstName!: string;

  @Prop({ required: true })
  lastName!: string;

  @Prop({ required: true })
  phoneNumber!: string;

  @Prop({ type: HomeAddressSchema, default: () => ({}) })
  homeAddress!: HomeAddress;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;

  // FCM device tokens for push notifications (one per signed-in device).
  // Populated by the saveFcmToken mutation; dead tokens are pruned on send.
  @Prop({ type: [String], default: [] })
  fcmTokens?: string[];

  // Staff-only fields
  @Prop({ type: String, ref: 'User', default: null })
  merchantId?: string;

  // Canonical per-branch grants. Written only through `deriveGrantFields`
  // (src/users/branch-access.util.ts), which emits this field and the two
  // derived mirrors below as one atomic $set so they can never disagree.
  @Prop({ type: [BranchAccessSchema], default: [] })
  branchAccess?: BranchAccess[];

  // DERIVED MIRROR of `branchAccess[].branchId`. Kept because every branch
  // scoping query in the codebase (tenant-scope.ts, assertAssignableCourier,
  // the device flow) reads it. Do not $set it directly — use deriveGrantFields.
  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'Branch', default: [] })
  branchIds?: string[];

  // DERIVED MIRROR: the UNION of every branch's grants.
  //
  // NEVER GATE ON THIS. A union answers "may this person do X somewhere?",
  // which is precisely the question branch-scoped permissions exist to stop
  // anyone asking — gating on it would let a Makati grant authorize a BGC
  // action. It survives only to serve the deprecated `permissionIds` GraphQL
  // field until the app rollout completes, and as a migration artefact.
  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: 'Permission',
    default: [],
  })
  permissionIds?: string[];

  @Prop({ type: Boolean, default: false })
  isArchived?: boolean;

  @Prop({ type: Date, default: null })
  archivedAt?: Date;

  // ─── Courier liveness selfie ────────────────────────────────────────────
  // Written only by CourierVerificationService. Denormalized onto the user so
  // GqlAuthGuard can read the gate state from the already-cached user document
  // — the guard runs on every request, and a per-request lookup into
  // courier_selfies would be a real cost. courier_selfies stays the history.
  //
  // Public URL of the live selfie; doubles as the courier's profile picture.
  @Prop({ type: String, default: null })
  photoUrl?: string | null;

  // null ⇒ never submitted. Only ACTIVE opens the gate; REVOKED re-locks the
  // courier until they retake. Values mirror CourierSelfieStatus, minus
  // SUPERSEDED — a superseded row is never the user's current state.
  @Prop({ type: String, default: null })
  selfieStatus?: string | null;

  @Prop({ type: Date, default: null })
  selfieVerifiedAt?: Date | null;

  @Prop({ type: String, default: null })
  selfieRevokedReason?: string | null;

  // ─── Washer account status ───────────────────────────────────────────────
  // Written only by WasherService.setStatus, denormalized from
  // WasherProfile.status for the same reason selfieStatus is above: GqlAuthGuard
  // runs on every request and reads this off the already-cached user document
  // rather than looking up washer_profiles per request. null on every
  // non-washer account. Mirrors WasherStatus (src/washer/schemas/washer-profile.schema.ts).
  @Prop({ type: String, default: null })
  washerStatus?: string | null;

  // ─── Session revocation ─────────────────────────────────────────────────
  // Every token issued BEFORE this instant is rejected by GqlAuthGuard.
  //
  // Read off the cached user document, like selfieStatus and washerStatus
  // above, for the same reason: the guard runs on every request. That also
  // makes revocation effective as soon as the user cache is invalidated,
  // which is what setting this field does — without it, the guard's 50-minute
  // token cache would keep a revoked session alive for up to 50 minutes even
  // if the Firebase refresh token were revoked at the same time.
  //
  // Firebase's own revokeRefreshTokens() is called alongside this, and it is
  // the durable half: this field stops the ACCESS token that is already in
  // the caller's hands, Firebase stops them getting a new one.
  @Prop({ type: Date, default: null })
  sessionsValidAfter?: Date | null;

  // ─── Self-service account deletion lifecycle ────────────────────────────
  // Written only by AccountDeletionService (src/account-deletion/).
  @Prop({ type: String, enum: AccountStatus, default: AccountStatus.ACTIVE })
  accountStatus?: AccountStatus;

  @Prop({ type: Date, default: null })
  deletionRequestedAt?: Date;

  /** End of the grace period — when the erasure job may run. */
  @Prop({ type: Date, default: null })
  deletionScheduledAt?: Date;

  @Prop({ type: Date, default: null })
  deletionCancelledAt?: Date;

  @Prop({ type: Date, default: null })
  deletedAt?: Date;

  @Prop({ type: Date, default: null })
  anonymizedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Drives the nightly grace-period sweep (additive, non-unique).
UserSchema.index({ accountStatus: 1, deletionScheduledAt: 1 });
