import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Product } from '../schemas/product.schema';

@ObjectType()
export class PaginatedProducts {
  @Field(() => [Product]) data!: Product[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
