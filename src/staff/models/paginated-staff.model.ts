import { ObjectType, Field, Int } from '@nestjs/graphql';
import { UserType } from '../../users/models/user.model';

@ObjectType()
export class PaginatedStaff {
  @Field(() => [UserType]) data!: UserType[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
