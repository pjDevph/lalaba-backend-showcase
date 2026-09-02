import { ObjectType, Field, Int } from '@nestjs/graphql';
import { AdminAuditEvent } from '../schemas/admin-audit-event.schema';

/** Standard page envelope, matching the other Paginated* types. */
@ObjectType()
export class PaginatedAdminAuditEvents {
  @Field(() => [AdminAuditEvent]) data!: AdminAuditEvent[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
