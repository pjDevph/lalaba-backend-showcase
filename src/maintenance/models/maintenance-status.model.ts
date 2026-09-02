import { Field, ObjectType } from '@nestjs/graphql';
import { MaintenanceType } from '../schemas/maintenance-config.schema';

// What the CALLER's own app looks like right now — never the raw config (the
// caller has no business knowing the other app's settings, or the bypass
// list). This is the one query `@AllowDuringMaintenance()` exempts, so a
// blocked app can still learn when it'll be unblocked.
@ObjectType()
export class MaintenanceStatus {
  @Field() blocked!: boolean;

  @Field(() => MaintenanceType, { nullable: true })
  type?: MaintenanceType | null;

  @Field(() => String, { nullable: true })
  message?: string | null;

  @Field(() => Date, { nullable: true })
  endsAt?: Date | null;

  /**
   * Support contact, carried on the STATUS rather than read from a separate
   * query — the app asking this one is, by definition, blocked from asking
   * anything else. Present whether or not the caller is currently blocked;
   * an unblocked app simply has nothing to do with it.
   */
  @Field(() => String, { nullable: true })
  supportEmail?: string | null;

  @Field(() => String, { nullable: true })
  supportPhone?: string | null;
}
