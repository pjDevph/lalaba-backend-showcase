import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  PricingType,
  ServiceCategory,
} from '../../services/schemas/service.schema';
import { WasherServiceUnit } from '../../washer-service-templates/schemas/washer-service-template.schema';

// A customer-readable catalog item for a provider. `serviceRefId` is exactly
// the value OrderServiceLineInput.serviceRefId expects: a Service._id for
// merchants, a WasherServiceTemplate._id for washers. `price` mirrors the unit
// convention the booking path (buildServiceLineSnapshot) already uses, so a
// quote computed from these items matches the eventual order.
@ObjectType()
export class ProviderServiceItem {
  @Field(() => ID) serviceRefId!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;

  @Field(() => Float) price!: number;
  @Field(() => PricingType) pricingType!: PricingType;
  @Field(() => Float, { nullable: true }) baseKilos?: number;
  @Field(() => Float, { nullable: true }) excessRate?: number;

  @Field(() => ServiceCategory, { nullable: true }) category?: ServiceCategory;
  @Field(() => Float, { nullable: true }) minKg?: number;

  // Counted services only (PER_PIECE). Without these the customer app can say
  // no more than "How many items?" and lets any count through, only for the
  // booking to be rejected server-side by the washer's own limits.
  @Field(() => WasherServiceUnit, { nullable: true }) unit?: WasherServiceUnit;
  @Field(() => Int, { nullable: true }) minQuantity?: number;
  @Field(() => Int, { nullable: true }) maxQuantity?: number;

  // True for washer templates — the "Lalaba-approved" badge on screen 068.
  @Field() approved!: boolean;

  @Field({ nullable: true }) readyInHint?: string;
}
