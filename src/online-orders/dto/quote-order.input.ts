import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DeliverySubMode,
  TurnaroundTierCode,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  ProviderType,
} from '../schemas/order-status.enum';

@InputType()
export class QuoteServiceLineInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  serviceRefId!: string; // Service._id (merchant) or WasherServiceTemplate._id (washer)

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  estimatedWeightKg?: number;

  // For per-piece / per-load services (count-priced, not weight).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  estimatedPieceCount?: number;

  @IsOptional()
  @IsArray()
  @Field(() => [ID], { nullable: true })
  replacementProductIds?: string[];
}

// Same essential shape as CreateOrderInput but without addressId/fulfillment —
// a pure pricing preview that never persists an order. Powers the running
// booking-footer estimate and the Review screen (screens 081, 109).
@InputType()
export class QuoteOrderInput {
  @IsEnum(ProviderType)
  @Field(() => ProviderType)
  providerType!: ProviderType;

  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  branchId!: string;

  @ValidateNested({ each: true })
  @Type(() => QuoteServiceLineInput)
  @Field(() => [QuoteServiceLineInput])
  serviceLines!: QuoteServiceLineInput[];

  // Fulfillment selection — lets the quote include the server-authoritative
  // pickup/return fees (GAP-P0-005). Omitted → fees quoted as ₱0 with the
  // free-batch defaults, matching an unselected booking footer.
  @IsOptional()
  @IsEnum(FulfillmentPickupMode)
  @Field(() => FulfillmentPickupMode, { nullable: true })
  pickupMode?: FulfillmentPickupMode;

  // FREE_BATCH (default, ₱0) or SCHEDULED_PAID (₱50) pickup window.
  @IsOptional()
  @IsEnum(DeliverySubMode)
  @Field(() => DeliverySubMode, { nullable: true })
  pickupSubMode?: DeliverySubMode;

  @IsOptional()
  @IsEnum(FulfillmentReturnMode)
  @Field(() => FulfillmentReturnMode, { nullable: true })
  returnMode?: FulfillmentReturnMode;

  @IsOptional()
  @IsEnum(DeliverySubMode)
  @Field(() => DeliverySubMode, { nullable: true })
  deliverySubMode?: DeliverySubMode;

  /**
   * How fast the laundry must be DONE. Independent of the delivery legs, so a
   * self-pickup customer can buy speed too. Defaults to STANDARD (free).
   */
  @IsOptional()
  @IsEnum(TurnaroundTierCode)
  @Field(() => TurnaroundTierCode, { nullable: true })
  turnaroundTier?: TurnaroundTierCode;

  /**
   * Previewed the same way createOrder applies it — validated fresh against
   * this customer and this order's actual subtotal, never trusted from a
   * prior response. An invalid/expired code is silently ignored in the
   * quote (no discount applied) rather than rejecting the whole quote, since
   * the customer hasn't committed to anything yet.
   */
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  promoCode?: string;
}
