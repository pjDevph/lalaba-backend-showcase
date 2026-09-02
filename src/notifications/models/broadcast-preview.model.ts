import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Broadcast } from '../schemas/broadcast.schema';

/**
 * What a broadcast would do, before it does it.
 *
 * Three numbers rather than one, because they are usually very different and
 * the difference is the point: an audience of 4,000 accounts where only 1,200
 * have ever opened the app is a fact the admin should know while they are
 * still writing the message.
 */
@ObjectType()
export class BroadcastPreview {
  /** Accounts matching the selected roles. */
  @Field(() => Int) audienceCount!: number;
  /** Of those, how many have at least one device that can receive a push. */
  @Field(() => Int) reachableCount!: number;
  /** Total devices. Higher than reachableCount — people have more than one. */
  @Field(() => Int) tokenCount!: number;
}

@ObjectType()
export class PaginatedBroadcasts {
  @Field(() => [Broadcast]) data!: Broadcast[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
