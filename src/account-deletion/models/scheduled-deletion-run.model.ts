import { Field, Int, ObjectType } from '@nestjs/graphql';

// Result of one grace-period sweep (nightly job or the admin-triggered run).
@ObjectType()
export class ScheduledDeletionRunResult {
  @Field(() => Int)
  processed!: number;

  @Field(() => Int)
  failed!: number;
}
