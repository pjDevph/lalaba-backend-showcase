import { ObjectType, Field, Int } from '@nestjs/graphql';
import { InventoryTransaction } from '../schemas/inventory-transaction.schema';

@ObjectType()
export class PaginatedTransactions {
  @Field(() => [InventoryTransaction]) data!: InventoryTransaction[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
