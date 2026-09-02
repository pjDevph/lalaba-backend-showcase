import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import {
  BranchAddress,
  BranchAddressSchema,
  MapLocation,
  MapLocationSchema,
  OperatingHours,
  OperatingHoursSchema,
  RatingAggregate,
  RatingAggregateSchema,
} from './sub-documents.schema';

export type BranchDocument = Branch & Document;

// Drives the Verified/Unverified badge ONLY. It does not gate discovery,
// marketplace visibility, or wallet top-up — see discovery.service.ts:185 and
// provider-eligibility.service.ts:104, which deliberately do not consult it.
export enum BranchVerificationStatus {
  PENDING = 'PENDING',
  // Every required document has been submitted and none is rejected — a
  // reviewer has the full set in hand. Distinct from PENDING so the partner
  // app can say "under review" instead of leaving the card on "incomplete"
  // after the merchant has done everything asked of them.
  IN_REVIEW = 'IN_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}
registerEnumType(BranchVerificationStatus, {
  name: 'BranchVerificationStatus',
});

// How the business is registered. Determines which registration documents a
// merchant is asked for during verification.
export enum BranchBusinessType {
  SOLE_PROPRIETORSHIP = 'SOLE_PROPRIETORSHIP',
  PARTNERSHIP = 'PARTNERSHIP',
  CORPORATION = 'CORPORATION',
  COOPERATIVE = 'COOPERATIVE',
}
registerEnumType(BranchBusinessType, { name: 'BranchBusinessType' });

@ObjectType()
@Schema({ timestamps: true }) // Automatically injects createdAt and updatedAt fields
export class Branch {
  @Field(() => ID)
  _id!: string; // branchId

  @Field(() => String)
  @Prop({ type: MongooseSchema.Types.String, ref: 'User', required: true })
  uid!: string; // Foreign Key to User collection

  @Field()
  @Prop({ required: true, trim: true })
  branchName!: string;

  @Field(() => BranchAddress)
  @Prop({ type: BranchAddressSchema, required: true })
  branchAddress!: BranchAddress;

  @Field(() => MapLocation)
  @Prop({ type: MapLocationSchema, required: true })
  branchMapLocation!: MapLocation;

  @Field()
  @Prop({ required: true, trim: true })
  branchPhoneNumber!: string;

  @Field(() => OperatingHours)
  @Prop({ type: OperatingHoursSchema, required: true })
  operatingHours!: OperatingHours;

  @Field({ nullable: true })
  @Prop({ type: String, default: null, trim: true })
  gcashNumber?: string;

  // Shop profile — shared shape with WasherProfile: one logo, one cover
  // photo, a description. No gallery.
  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  logoUrl?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  coverPhotoUrl?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  description?: string;

  @Field(() => RatingAggregate)
  @Prop({ type: RatingAggregateSchema, default: () => ({}) })
  ratingAggregate!: RatingAggregate;

  // ── Business registration details ───────────────────────────────────────
  // Self-attested by the merchant and cross-checked by a reviewer against the
  // DTI/BIR documents submitted through the KYC module. All nullable: branches
  // created before verification existed have none of them.
  @Field(() => BranchBusinessType, { nullable: true })
  @Prop({ type: String, enum: BranchBusinessType, default: null })
  businessType?: BranchBusinessType;

  @Field({ nullable: true })
  @Prop({ type: String, default: null, trim: true })
  dtiRegistrationNumber?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null, trim: true })
  tin?: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null, trim: true, lowercase: true })
  businessEmail?: string;

  // Badge only — never a discovery or top-up gate (see the enum above).
  @Field(() => BranchVerificationStatus)
  @Prop({
    type: String,
    enum: BranchVerificationStatus,
    default: BranchVerificationStatus.PENDING,
  })
  verificationStatus!: BranchVerificationStatus;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  verifiedAt?: Date;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  verifiedBy?: string;

  /**
   * Which edition of the KYC required-document policy this branch was verified
   * under (KYC_POLICY_VERSION at the time). Null on a branch that has never
   * been approved. Stored rather than inferred so a grandfathered provider is
   * not mistaken for an incomplete one when the required set later grows.
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null })
  verificationPolicyVersion?: number | null;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  rejectionReason?: string;

  @Field()
  @Prop({ default: true })
  isActive!: boolean;

  // The merchant's own open/closed toggle. Public discovery requires
  // isOnline === true; verificationStatus is NOT consulted.
  @Field()
  @Prop({ default: true })
  isOnline!: boolean;

  // Provider opt-in for deferred settlement (phase2-settled-decisions.md §14).
  // When true the courier may record a pickup as AT_FINAL_HANDOVER and the
  // customer pays the whole amount when the laundry comes back. Extending
  // credit is each shop's own call, so this is off by default — flipping it on
  // for every existing shop at deploy would be a money change nobody agreed to.
  //
  // The platform fee is consumed from this branch's wallet at pickup either
  // way: the provider fronts it. A shop carrying many deferred orders burns
  // balance with no offsetting collection and can fall below the discovery
  // floor faster than usual, which the opt-in copy should say.
  //
  // A washer's anchor Branch supplies this too, so one field covers both
  // provider types with no polymorphism.
  @Field()
  @Prop({ default: false })
  allowsPayAtHandover!: boolean;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BranchSchema = SchemaFactory.createForClass(Branch);
