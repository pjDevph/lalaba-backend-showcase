import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

// A unified marketplace card for either a merchant Branch or a Home Washer,
// federated by DiscoveryService the way OrderDashboardService federates
// pos_orders + online_orders. Washers deliberately expose only a generalized
// area (never exact address/coords) — enforced here, not by storing less.
@ObjectType()
export class ProviderCard {
  @Field(() => ID)
  branchId!: string;

  @Field(() => ProviderType)
  providerType!: ProviderType;

  @Field()
  name!: string;

  // Home washer only — the person operating the business (owner's name), shown
  // as "Operated by: …" on the card. Null for merchants (the branch name is the
  // business identity).
  @Field({ nullable: true })
  operatorName?: string;

  @Field()
  initials!: string;

  // e.g. ['LAUNDROMAT','VERIFIED_BUSINESS'] or ['VERIFIED_HOME_WASHER']
  @Field(() => [String])
  verificationBadges!: string[];

  @Field(() => Float)
  ratingAverage!: number;

  @Field(() => Int)
  ratingCount!: number;

  // "Open", "Closed", "1 slot left" — human-facing status line.
  @Field()
  statusText!: string;

  // The real gate a booking attempt will hit — merchant Branch.isOnline or
  // washer.isAvailable (both also require operating hours where applicable).
  // `statusText` is prose meant for display; this is what the FE should
  // actually branch on to disable "Book" rather than string-matching against
  // "Not accepting bookings", which breaks the moment that copy changes.
  @Field()
  isAcceptingBookings!: boolean;

  @Field(() => Float, { nullable: true })
  distanceKm?: number;

  /**
   * How far this provider will actually travel, in km. Washers only —
   * a laundromat has no service radius.
   *
   * Carried on the card because discovery has to compare against it: the
   * customer's distance filter is a PREFERENCE that can only narrow the list,
   * whereas this is a hard constraint the create path enforces. Listing a
   * washer beyond it meant advertising a provider who would refuse the booking
   * at the last step.
   *
   * Not exposed to clients — it is a filter input, not something a customer
   * needs to read, and publishing it would leak how far a washer's home is
   * from the addresses she serves.
   */
  serviceRadiusKm?: number | null;

  // Lowest service price the provider offers, in the same unit convention the
  // booking path uses (see DiscoveryService.priceFromFor). Null if no catalog.
  @Field(() => Float, { nullable: true })
  priceFromCentavos?: number;

  @Field(() => [String])
  serviceCategories!: string[];

  // Washer only — remaining daily bookings (cap − used today).
  @Field(() => Int, { nullable: true })
  slotsRemaining?: number;

  @Field()
  isFavorite!: boolean;

  // Trust badge — merchant approved / home washer identity-verified. Drives the
  // "Verified" vs "Unverified" ribbon on the marketplace card.
  @Field()
  isVerified!: boolean;

  // Generalized location line — barangay/city. For washers this is the ONLY
  // location detail exposed; for merchants it complements the exact address.
  @Field({ nullable: true })
  areaLabel?: string;

  @Field({ nullable: true })
  logoUrl?: string;

  @Field({ nullable: true })
  coverPhotoUrl?: string;
}
