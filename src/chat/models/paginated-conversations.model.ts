import { Field, Int, ObjectType } from '@nestjs/graphql';
import { Conversation } from '../schemas/conversation.schema';

@ObjectType()
export class PaginatedConversations {
  @Field(() => [Conversation]) data!: Conversation[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
