import { ObjectType, Field, Int } from '@nestjs/graphql';
import { PosOrder } from '../schemas/pos-order.schema';

@ObjectType()
export class PaginatedOrders {
  @Field(() => [PosOrder]) data!: PosOrder[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
