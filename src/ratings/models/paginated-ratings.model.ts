import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Rating } from '../schemas/rating.schema';

@ObjectType()
export class PaginatedRatings {
  @Field(() => [Rating]) data!: Rating[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
