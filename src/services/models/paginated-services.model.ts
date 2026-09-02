import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Service } from '../schemas/service.schema';

@ObjectType()
export class PaginatedServices {
  @Field(() => [Service]) data!: Service[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
