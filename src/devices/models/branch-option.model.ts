import { ObjectType, Field, ID } from '@nestjs/graphql';

// Lightweight branch {id, name} for a staff's device-registration dropdown.
// Staff cannot read the full Branch type (owner-scoped), so this exposes just
// the id + name they need to pick a branch.
@ObjectType()
export class BranchOption {
  @Field(() => ID)
  _id!: string;

  @Field()
  name!: string;
}
