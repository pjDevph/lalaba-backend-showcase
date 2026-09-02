import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';
import {
  BranchAddress,
  MapLocation,
  OperatingHours,
} from '../../branches/schemas/sub-documents.schema';

@ObjectType()
export class RatingHistogramBucket {
  @Field(() => Int) star!: number; // 1..5
  @Field(() => Int) count!: number;
}

// The four Verified Home Washer checks surfaced on screen 075. Merchants use
// the simpler VERIFIED_BUSINESS badge and don't carry this block.
@ObjectType()
export class WasherVerificationDetail {
  @Field() identityVerified!: boolean;
  @Field() residenceConfirmed!: boolean;
  @Field() servicesReviewed!: boolean;
  @Field() paymentAccountVerified!: boolean;
  @Field({ nullable: true }) verifiedOn?: Date;
  @Field({ nullable: true }) recheckCadence?: string; // "Every 6 months"
}

/** The provider's paid speed offer, so the app only shows it when it exists. */
@ObjectType()
export class ExpressTurnaroundPolicy {
  @Field() enabled!: boolean;
  @Field(() => Int, { nullable: true }) feeCentavos?: number;
  /** Hours from provider-received to laundry-ready. */
  @Field(() => Int, { nullable: true }) slaHours?: number;
}

@ObjectType()
export class ProviderPolicies {
  @Field(() => Float, { nullable: true }) minOrderKg?: number;
  @Field() freeBatchDelivery!: boolean;
  /** @deprecated Never populated; superseded by `expressTurnaround`. */
  @Field({ nullable: true }) expressCutoff?: string;
  @Field(() => ExpressTurnaroundPolicy, { nullable: true })
  expressTurnaround?: ExpressTurnaroundPolicy;
}

// Public provider profile. Address/coords/hours resolve for merchants; for
// washers only `areaLabel` is populated (address/mapLocation stay null) so the
// app renders the privacy-safe general-area view (screen 073).
@ObjectType()
export class ProviderProfile {
  @Field(() => ID) branchId!: string;
  @Field(() => ProviderType) providerType!: ProviderType;
  @Field() name!: string;
  @Field() initials!: string;
  @Field(() => [String]) verificationBadges!: string[];

  @Field(() => Float) ratingAverage!: number;
  @Field(() => Int) ratingCount!: number;
  @Field(() => [RatingHistogramBucket])
  ratingHistogram!: RatingHistogramBucket[];

  @Field({ nullable: true }) description?: string;
  @Field({ nullable: true }) logoUrl?: string;
  @Field({ nullable: true }) coverPhotoUrl?: string;
  // Home-washer gallery. Always present, empty for merchants — laundromats
  // have a shopfront and an address instead.
  @Field(() => [String]) featuredPhotos!: string[];

  @Field(() => BranchAddress, { nullable: true }) address?: BranchAddress; // merchant only
  @Field(() => MapLocation, { nullable: true }) mapLocation?: MapLocation; // merchant only
  @Field({ nullable: true }) areaLabel?: string; // washer general area

  @Field(() => OperatingHours, { nullable: true })
  operatingHours?: OperatingHours;

  // FulfillmentPickupMode / FulfillmentReturnMode values the provider supports.
  @Field(() => [String]) supportedFulfillment!: string[];

  @Field(() => ProviderPolicies) policies!: ProviderPolicies;
  @Field(() => [String]) serviceCategories!: string[];

  @Field(() => Int, { nullable: true }) slotsRemaining?: number;
  @Field() statusText!: string;
  // The real gate a booking attempt will hit — see ProviderCard.isAcceptingBookings.
  @Field() isAcceptingBookings!: boolean;
  @Field() isFavorite!: boolean;

  // Whether this shop offers deferred settlement (§14). Surfaced at booking so
  // the customer knows the option will be there after the weigh-in — the
  // choice itself is made at pickup, once a real total exists.
  @Field() allowsPayAtHandover!: boolean;

  @Field(() => WasherVerificationDetail, { nullable: true })
  washerVerification?: WasherVerificationDetail;
}
