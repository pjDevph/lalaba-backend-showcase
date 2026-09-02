import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Branch } from '../schemas/branch.schema';

@ObjectType()
export class PaginatedBranches {
  @Field(() => [Branch]) data!: Branch[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
