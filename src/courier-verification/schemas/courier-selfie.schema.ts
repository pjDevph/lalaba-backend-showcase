import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export type CourierSelfieDocument = CourierSelfie & Document;

// Lifecycle of one submitted selfie row.
//
// Unlike KYC (which is approve-before-badge), a selfie goes live the moment the
// client reports a passing liveness challenge — the courier is unblocked with no
// reviewer in the loop. Admin review is post-hoc and its only verdict is REVOKED.
export enum CourierSelfieStatus {
  /** Live: this is the courier's current photo and their gate is open. */
  ACTIVE = 'ACTIVE',
  /** Replaced by a newer submission from the same courier. */
  SUPERSEDED = 'SUPERSEDED',
  /** Taken down by an admin/support reviewer; the courier is re-locked. */
  REVOKED = 'REVOKED',
}
registerEnumType(CourierSelfieStatus, { name: 'CourierSelfieStatus' });

// Which action the client asked the courier to perform to prove liveness. Chosen
// at random per attempt so a pre-recorded clip of one action does not generalise.
export enum LivenessChallenge {
  BLINK = 'BLINK',
  TURN_LEFT = 'TURN_LEFT',
  TURN_RIGHT = 'TURN_RIGHT',
}
registerEnumType(LivenessChallenge, { name: 'LivenessChallenge' });

// What the on-device check observed, recorded verbatim for the admin reviewer.
//
// This is a CLIENT ASSERTION and nothing more. The server cannot verify any of
// it — a modified build can send whatever it likes. It exists to give a human
// reviewer context, never to authorize anything on its own. The real backstops
// are post-hoc review, revocation, and the photo being publicly attached to the
// rider's deliveries.
@ObjectType()
@Schema({ _id: false })
export class LivenessMetadata {
  /** Milliseconds from challenge issued to challenge satisfied. */
  @Field(() => Int)
  @Prop({ type: Number, required: true })
  durationMs!: number;

  /** Face-detector confidence that both eyes were open at capture (0..1). */
  @Field()
  @Prop({ type: Number, required: true })
  eyesOpenScore!: number;

  /** Head yaw in degrees at capture; near zero means facing the camera. */
  @Field()
  @Prop({ type: Number, required: true })
  yawDegrees!: number;

  /** Head pitch in degrees at capture. */
  @Field()
  @Prop({ type: Number, required: true })
  pitchDegrees!: number;

  /** How many attempts the courier burned before this one passed. */
  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  attemptCount!: number;
}
export const LivenessMetadataSchema =
  SchemaFactory.createForClass(LivenessMetadata);

@ObjectType()
@Schema({ collection: 'courier_selfies', timestamps: true })
export class CourierSelfie {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  courierUid!: string;

  // Key in the PUBLIC bucket. Unlike KYC's storageObjectKey this one is safe to
  // pair with a public URL, but it is still kept off GraphQL — clients have no
  // use for it, and it is what StorageProvider.delete() needs on revoke.
  @Prop({ type: String, required: true })
  storageKey!: string;

  @Field()
  @Prop({ type: String, required: true })
  publicUrl!: string;

  @Field(() => CourierSelfieStatus)
  @Prop({
    type: String,
    enum: CourierSelfieStatus,
    default: CourierSelfieStatus.ACTIVE,
  })
  status!: CourierSelfieStatus;

  @Field(() => LivenessChallenge)
  @Prop({ type: String, enum: LivenessChallenge, required: true })
  livenessChallenge!: LivenessChallenge;

  @Field(() => LivenessMetadata)
  @Prop({ type: LivenessMetadataSchema, required: true })
  livenessMetadata!: LivenessMetadata;

  @Field()
  @Prop({ type: String, required: true })
  mimeType!: string;

  @Field(() => Int)
  @Prop({ type: Number, required: true })
  fileSizeBytes!: number;

  @Field()
  @Prop({ type: Date, required: true })
  submittedAt!: Date;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  revokedByUid?: string;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  revokedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  revocationReason?: string;

  // Set on the NEW row when it replaces an earlier submission — points at the
  // row it superseded, so the history reads as a chain rather than a set.
  @Field(() => ID, { nullable: true })
  @Prop({ type: String, default: null })
  supersedesId?: string | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const CourierSelfieSchema = SchemaFactory.createForClass(CourierSelfie);

// One live row per courier is the invariant the whole flow rests on. Partial
// unique index rather than a plain one: SUPERSEDED/REVOKED rows accumulate
// freely, but a second ACTIVE row for the same courier is rejected by the DB
// even if application-level supersession is ever raced.
CourierSelfieSchema.index(
  { courierUid: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: CourierSelfieStatus.ACTIVE },
  },
);
// Admin queue: newest first.
CourierSelfieSchema.index({ status: 1, submittedAt: -1 });
