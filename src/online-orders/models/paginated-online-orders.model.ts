import { ObjectType, Field, Int } from '@nestjs/graphql';
import { OnlineOrder } from '../schemas/online-order.schema';

/**
 * Standard page envelope, matching PaginatedDashboardOrders and the other
 * Paginated* types so admin list screens can share their paging code.
 */
@ObjectType()
export class PaginatedOnlineOrders {
  @Field(() => [OnlineOrder]) data!: OnlineOrder[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
