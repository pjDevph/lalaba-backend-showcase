import { ObjectType, Field, Int } from '@nestjs/graphql';
import { DashboardOrder } from './dashboard-order.model';

@ObjectType()
export class PaginatedDashboardOrders {
  @Field(() => [DashboardOrder]) data!: DashboardOrder[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
