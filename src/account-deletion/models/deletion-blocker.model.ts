import { Field, Int, ObjectType } from '@nestjs/graphql';

// Shape frozen by the Partner FE contract:
// accountDeletionBlockers { code message count ids }
@ObjectType()
export class DeletionBlocker {
  @Field()
  code!: string;

  @Field()
  message!: string;

  @Field(() => Int)
  count!: number;

  @Field(() => [String])
  ids!: string[];
}
