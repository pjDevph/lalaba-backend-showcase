import { ObjectType, Field, ID } from '@nestjs/graphql';

// "Is this person's app open right now" — intentionally coarse, no history,
// no per-device granularity. Any signed-in user may query any other uid's
// status; this is not sensitive in the way KYC/evidence data is.
@ObjectType()
export class PresenceStatus {
  @Field(() => ID)
  uid!: string;

  @Field()
  isOnline!: boolean;

  @Field(() => Date, { nullable: true })
  lastSeenAt!: Date | null;
}
