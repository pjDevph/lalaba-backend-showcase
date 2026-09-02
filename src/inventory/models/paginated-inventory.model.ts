import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Inventory } from '../schemas/inventory.schema';

@ObjectType()
export class PaginatedInventory {
  @Field(() => [Inventory]) data!: Inventory[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
