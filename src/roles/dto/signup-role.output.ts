import { ObjectType, Field, ID } from '@nestjs/graphql';

/**
 * The minimal public projection of a role, for the sign-up screens (SEC-004).
 *
 * Deliberately NOT the `Role` type. `Role` carries `description`, and any field
 * later added to `Role` would be inherited by this public query for free — the
 * exact accident that made `listRoles` a full anonymous dump of the
 * authorization model. This type is a separate, closed surface: three fields,
 * each one required by the sign-up flow, and adding a fourth is a conscious
 * edit to a file whose whole purpose is to be small.
 *
 * `_id` is the field that forces this query to exist at all: registration
 * identifies a role by its Mongo `_id`, and the client must supply it before it
 * has a token to authenticate with.
 */
@ObjectType()
export class SignupRole {
  @Field(() => ID)
  _id!: string;

  /** Stable slug the clients match on, e.g. "customer", "merchant", "washer". */
  @Field(() => String)
  roleId!: string;

  /** Human-readable label for a role picker. */
  @Field(() => String)
  roleName!: string;
}
