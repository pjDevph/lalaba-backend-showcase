import { ObjectType, Field, Int } from '@nestjs/graphql';
import { UserType } from './user.model';

@ObjectType()
export class PaginatedUsers {
  @Field(() => [UserType]) data!: UserType[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
