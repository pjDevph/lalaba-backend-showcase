import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * Platform-wide, not scoped to any merchant/branch — the admin dashboard's
 * "today" figure. Completed orders only: a fee isn't platform revenue until
 * the order it came from is done.
 */
@ObjectType()
export class PlatformStatsToday {
  @Field(() => Int)
  revenueCentavos: number;

  @Field(() => Int)
  completedOrders: number;
}
