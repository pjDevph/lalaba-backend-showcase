import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * Admin-facing view of one AccountDeletionRecord, joined with the live User
 * doc for display. On a COMPLETED row that join legitimately shows
 * "Deleted User" / the anonymized placeholder email — the record itself is
 * deliberately PII-free (see the schema's own comment), and by the time a
 * row reaches completedAt there is no PII left to show either. That is
 * correct, not a bug: the anonymized name IS the account's current identity.
 */
@ObjectType()
export class DeletionQueueEntry {
  @Field(() => ID)
  uid!: string;

  @Field({ nullable: true })
  roleId?: string;

  @Field()
  displayName!: string;

  @Field()
  email!: string;

  @Field()
  requestedAt!: Date;

  @Field()
  scheduledAt!: Date;

  // Explicit () => Date: a `Date | undefined` field has no reflectable
  // design type, so the implicit @Field({nullable:true}) form fails only at
  // GraphQL schema-BUILD time — not caught by tsc or unit tests. Bitten by
  // this shape repeatedly elsewhere in this codebase (promo-code.schema.ts,
  // platform-fee-rule.schema.ts).
  @Field(() => Date, { nullable: true })
  cancelledAt?: Date;

  @Field({ nullable: true })
  cancelledBy?: string;

  @Field(() => Date, { nullable: true })
  completedAt?: Date;
}
