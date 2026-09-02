import {
  ObjectType,
  Field,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';

/**
 * A bookable pickup DAY, with what each tier would cost on it.
 *
 * This replaced a 30-minute time-window picker. Two things killed the window:
 * a free pickup is batched with nearby collections, so an exact time was never
 * a promise the provider could keep — and no provider surface ever showed the
 * window, so the person meant to honour it could not see it.
 *
 * The tier is now the customer's explicit choice rather than something derived
 * from a window's position in the day's list, which is why both prices are
 * returned per day instead of one price per slot.
 */
@ObjectType()
export class PickupDay {
  /** 'YYYY-MM-DD', PH-local. */
  @Field() date!: string;
  /** 'Mon, Aug 18', ready to render. */
  @Field() label!: string;
  @Field() isBookable!: boolean;
  /** Places left in the day's capacity. */
  /** Null means unlimited — see BookingAvailabilityDay.remaining. */
  @Field(() => Int, { nullable: true }) remaining?: number | null;
  /** Why the day cannot be booked, when it cannot. Already customer-worded. */
  @Field({ nullable: true }) unavailableReason?: string;

  /** Batched with nearby collections — the provider picks the time. */
  @Field(() => Float) freeBatchFeeCentavos!: number;
  /** Priority collection, priced by the provider. */
  @Field(() => Float) paidPickupFeeCentavos!: number;
}

/**
 * Kept only for the stored `DeliverySubMode` on existing orders. New code
 * should read the two fee fields above.
 *
 * @deprecated superseded by PickupDay; removed once no client reads it.
 */
export enum PickupSlotAvailability {
  FREE_BATCH = 'free_batch',
  SCHEDULED_PAID = 'scheduled_paid',
  FULLY_BOOKED = 'fully_booked',
}
registerEnumType(PickupSlotAvailability, { name: 'PickupSlotAvailability' });
