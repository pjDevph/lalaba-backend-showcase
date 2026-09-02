import { ObjectType, Field, ID } from '@nestjs/graphql';

/**
 * A courier who may be given a leg of a given branch's orders.
 *
 * Deliberately NOT `UserType`. Choosing a courier needs a name to tap, not a
 * staff record — and the callers include staff on the counter, who have no
 * business reading their colleagues' full profiles just to hand off a delivery.
 */
@ObjectType()
export class AssignableCourier {
  @Field(() => ID)
  _id: string;

  @Field()
  firstName: string;

  @Field()
  lastName: string;

  @Field({ nullable: true })
  email?: string;
}
