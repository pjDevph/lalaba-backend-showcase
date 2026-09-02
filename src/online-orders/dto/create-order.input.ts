import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';
import { Type } from 'class-transformer';
import {
  FulfillmentPickupMode,
  FulfillmentReturnMode,
  DeliverySubMode,
  TurnaroundTierCode,
  ProviderType,
  PaymentTiming,
} from '../schemas/order-status.enum';
import { ScheduledPickupInput } from '../../booking-availability/dto/booking-availability.input';

@InputType()
class OrderServiceLineInput {
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

  // Optional per-service handling note from the customer (e.g. "keep whites
  // separate"). Distinct from the order-level pickup instructions.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Field({ nullable: true })
  note?: string;

  // Products the customer swapped from the free default — see
  // ServiceProductDefault (§23). Removing a default needs nothing here;
  // only replacements (which add a surcharge) are listed.
  @IsOptional()
  @IsArray()
  @Field(() => [ID], { nullable: true })
  replacementProductIds?: string[];
}

@InputType()
class OrderInstructionsInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  pickupInstructions?: string;
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  accessInstructions?: string;
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  laundryCareInstructions?: string;
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  returnInstructions?: string;
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  customerGeneralNotes?: string;
}

// Explicit GraphQL name to avoid colliding with the pos_orders CreateOrderInput.
@InputType('CreateOnlineOrderInput')
export class CreateOrderInput {
  @IsEnum(ProviderType)
  @Field(() => ProviderType)
  providerType!: ProviderType;

  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  branchId!: string;

  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  addressId!: string; // customer's saved Address (§2) — snapshotted onto the order

  @ValidateNested({ each: true })
  @Type(() => OrderServiceLineInput)
  @Field(() => [OrderServiceLineInput])
  serviceLines!: OrderServiceLineInput[];

  @IsEnum(FulfillmentPickupMode)
  @Field(() => FulfillmentPickupMode)
  pickupMode!: FulfillmentPickupMode;

  // Pickup window tier for PROVIDER_PICKUP: FREE_BATCH (default, ₱0) or
  // SCHEDULED_PAID (₱50). Drives the server-side pickup fee (GAP-P0-005).
  @IsOptional()
  @IsEnum(DeliverySubMode)
  @Field(() => DeliverySubMode, { nullable: true })
  pickupSubMode?: DeliverySubMode;

  @IsEnum(FulfillmentReturnMode)
  @Field(() => FulfillmentReturnMode)
  returnMode!: FulfillmentReturnMode;

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

  // Pay at pickup (default) or pay-on-delivery.
  @IsOptional()
  @IsEnum(PaymentTiming)
  @Field(() => PaymentTiming, { nullable: true })
  paymentTiming?: PaymentTiming;

  @IsOptional()
  @ValidateNested()
  @Type(() => OrderInstructionsInput)
  @Field(() => OrderInstructionsInput, { nullable: true })
  instructions?: OrderInstructionsInput;

  /**
   * The handover window the customer picked, validated against the provider's
   * booking availability (see the booking-availability module).
   *
   * Nullable in the schema but effectively required for any provider who has
   * scheduled bookings switched on — createOrder rejects a missing window in
   * that case rather than silently placing an unscheduled order, because an
   * order with no window consumes no slot and would overfill the day. A
   * provider with `acceptScheduledBookings: false` still takes orders with no
   * window at all, which is what keeps pre-scheduling behaviour available.
   */
  @ValidateNested()
  @Type(() => ScheduledPickupInput)
  @Field(() => ScheduledPickupInput)
  scheduledPickup!: ScheduledPickupInput;

  /**
   * Re-validated and redeemed fresh at create time (PromotionsService never
   * trusts a discount amount the client claims a prior quote produced) — an
   * invalid/expired code here IS rejected, unlike quoteOrder's silent-ignore,
   * because at this point the customer is actually placing the order.
   */
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  promoCode?: string;
}
