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
import {
  BranchAddress,
  BranchAddressSchema,
  MapLocation,
  MapLocationSchema,
  RatingAggregate,
  RatingAggregateSchema,
  OperatingHours,
  OperatingHoursSchema,
} from '../../branches/schemas/sub-documents.schema';

export enum WasherStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
}
registerEnumType(WasherStatus, { name: 'WasherStatus' });

// Verification is deliberately a separate field from WasherStatus above — the
// operational on/off cycle and the KYC gate that controls marketplace
// visibility are two different concerns and must not be conflated.
// Kept deliberately in lockstep with BranchVerificationStatus — KycService
// recomputes both through one code path, so a value added to one must be
// added to the other.
export enum VerificationStatus {
  PENDING = 'PENDING',
  IN_REVIEW = 'IN_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}
registerEnumType(VerificationStatus, { name: 'VerificationStatus' });

export type WasherProfileDocument = WasherProfile & Document;

@ObjectType()
@Schema({ collection: 'washer_profiles', timestamps: true })
export class WasherProfile {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true, unique: true })
  uid!: string;

  @Field()
  @Prop({ type: String, required: true })
  displayName!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  phone?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  photoUrl?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  bio?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  machineType?: string;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null })
  machineCapacityKg?: number;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  machineBrand?: string;

  // Structured address + coordinates, same shape Branch uses. The public
  // discovery view generalizes this (barangay/city + approximate radius) —
  // exact fields resolve only for the washer herself, an active pickup/
  // return assignment, or Admin/Support. Enforced at the resolver layer,
  // not by storing less data here.
  @Field(() => BranchAddress, { nullable: true })
  @Prop({ type: BranchAddressSchema, default: null })
  address?: BranchAddress;

  @Field(() => MapLocation, { nullable: true })
  @Prop({ type: MapLocationSchema, default: null })
  mapLocation?: MapLocation;

  // Store hours — drives the "Open until 8:00 PM" status customers + the washer's
  // own dashboard preview see. Null → falls back to booking-availability text.
  @Field(() => OperatingHours, { nullable: true })
  @Prop({ type: OperatingHoursSchema, default: null })
  operatingHours?: OperatingHours;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null })
  serviceRadiusKm?: number;

  // Which admin-locked WasherServiceTemplate(s) she offers — she selects
  // from the catalog, she does not set pricing herself. Validated against
  // the active template catalog in WasherService.updateProfile, not a raw
  // client-trusted passthrough.
  @Field(() => [ID])
  @Prop({ type: [String], ref: 'WasherServiceTemplate', default: [] })
  offeredServiceTemplateIds!: string[];

  // Shop profile — one logo, one cover photo, a description, plus a small
  // gallery. Home washers have no shopfront, so the gallery (equipment,
  // workspace, finished laundry) is how they show customers what they're
  // buying; the washer app has always collected it.

  // The name customers see on the storefront — a laundromat's `branchName`
  // equivalent. Separate from `displayName`, which is her LEGAL/personal name
  // (seeded at registration and shown to Admin in KYC review): before this
  // existed, discovery fell back to displayName, so every home washer's shop
  // was listed under her own name with no way to change it. Nothing falls back
  // to displayName any more: a profile with no storeName reads as the generic
  // "Home Laundry" (see washer-name.util.ts), which is why every write path
  // seeds one and the backfill migration gives every existing washer hers.
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  storeName?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  logoUrl?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  coverPhotoUrl?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  description?: string;

  @Field(() => [String])
  @Prop({ type: [String], default: [] })
  featuredPhotos!: string[];

  @Field(() => RatingAggregate)
  @Prop({ type: RatingAggregateSchema, default: () => ({}) })
  ratingAggregate!: RatingAggregate;

  // ─── Certification evidence (RISK-P0-002 residue) ────────────────────────
  // LEGACY, public, and deliberately NOT a GraphQL field any more: these are
  // anonymously-readable object URLs from before evidence moved to the private
  // store. Reads go through the guarded `certificationProofUrls` query, which
  // still returns them during the transition. Emptied by
  // scripts/migrations/migrate-cert-proofs-to-private.ts once each object has
  // been copied into the private bucket.
  @Prop({ type: [String], default: null })
  certProofUrls?: string[];

  // Archive of the public URLs a migration run retired, kept so a run can be
  // audited/rolled back. Never exposed over GraphQL.
  @Prop({ type: [String], default: null })
  legacyCertProofUrls?: string[];

  // Private-store object keys for certification evidence — the forward path.
  // Never exposed over GraphQL (same rule as KycDocument.storageObjectKey);
  // reads are short-lived signed URLs from `certificationProofUrls`.
  @Prop({ type: [String], default: [] })
  certProofObjectKeys?: string[];

  @Field(() => WasherStatus)
  @Prop({ type: String, enum: WasherStatus, default: WasherStatus.ACTIVE })
  status!: WasherStatus;

  // Verification gates marketplace visibility only — a washer can freely
  // configure her shop (services, profile) before approval, she just won't
  // appear in customer discovery until this is APPROVED.
  @Field(() => VerificationStatus)
  @Prop({
    type: String,
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  verificationStatus!: VerificationStatus;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  verifiedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  verifiedBy?: string;

  /**
   * Which edition of the KYC required-document policy this washer was verified
   * under (KYC_POLICY_VERSION at the time). Null if never approved. See the
   * branch schema's copy — stored, not inferred, so growing the required set
   * cannot retroactively make a verified washer look incomplete.
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  verificationPolicyVersion?: number | null;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  rejectionReason?: string;

  @Field()
  @Prop({ type: Boolean, default: false })
  isAvailable!: boolean;

  // Admin-configured daily order cap, enforced at both booking-time and
  // acceptance-time. Null falls back to the platform-wide default rather
  // than forcing every washer to the same explicit number.
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  maxOrdersPerDay?: number;

  // Technical anchor only — lets the shared Inventory/Product schema's
  // required branchId FK work unmodified for a washer. Does not make her
  // conceptually a "branch" anywhere else in the system.
  @Field()
  @Prop({ type: String, ref: 'Branch', required: true })
  branchId!: string;

  // Storage key of the PUBLIC copy of her KYC selfie — the image now serving as
  // both her avatar (photoUrl) and her store logo (logoUrl).
  //
  // Deliberately NOT a GraphQL field: it is a storage pointer, not something a
  // client should see or resolve. It exists so a retake can delete the object it
  // replaced. Nulling photoUrl/logoUrl alone is not erasure — without this key
  // the superseded face would stay readable at its permanent public URL forever.
  @Prop({ type: String, default: null })
  selfiePublicObjectKey?: string | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const WasherProfileSchema = SchemaFactory.createForClass(WasherProfile);
