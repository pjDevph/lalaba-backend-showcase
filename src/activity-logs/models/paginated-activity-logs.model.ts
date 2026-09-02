import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ActivityLog } from '../schemas/activity-log.schema';

@ObjectType()
export class PaginatedActivityLogs {
  @Field(() => [ActivityLog]) data!: ActivityLog[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
