import { ObjectType, Field, ID } from '@nestjs/graphql';
import { HomeAddress } from '../schemas/address.schema';
import { AccountStatus } from '../schemas/user.schema';
import { PermissionGroup } from '../../permissions/permission-groups';
import { CourierSelfieStatus } from '../../courier-verification/schemas/courier-selfie.schema';

// One branch and the access held on it.
@ObjectType()
export class BranchAccessType {
  @Field(() => ID)
  branchId!: string;

  @Field(() => [PermissionGroup])
  groups!: PermissionGroup[];
}

@ObjectType()
export class UserType {
  @Field(() => ID)
  _id!: string; // <-- Added '!' to tell TS it will be populated at runtime

  @Field(() => String)
  role!: string;

  @Field(() => String)
  email!: string;

  @Field(() => String)
  firstName!: string;

  @Field(() => String)
  lastName!: string;

  @Field(() => String)
  phoneNumber!: string;

  @Field(() => HomeAddress)
  homeAddress!: HomeAddress;

  @Field(() => Boolean)
  isActive!: boolean;

  // Staff-only fields
  @Field(() => String, { nullable: true })
  merchantId?: string;

  // What this staff member may do, branch by branch. Exposed as GROUPS rather
  // than permission names: the owner-facing model is four switches, and handing
  // the app raw names would only invite it to re-derive the grouping itself —
  // which is how the app, the backend and the admin panel ended up with three
  // disagreeing copies of it.
  @Field(() => [BranchAccessType], { nullable: true })
  branchAccess?: BranchAccessType[];

  @Field(() => [String], { nullable: true })
  branchIds?: string[];

  @Field(() => [String], {
    nullable: true,
    deprecationReason:
      'Account-global grants are no longer authoritative — read branchAccess instead. This is the union across branches and cannot answer what a staff member may do at a given branch. Removed one release after the app rollout.',
  })
  permissionIds?: string[];

  @Field(() => Boolean, { nullable: true })
  isArchived?: boolean;

  @Field(() => Date, { nullable: true })
  archivedAt?: Date;

  // Courier liveness selfie (see src/courier-verification/). photoUrl is the
  // courier's profile picture; selfieStatus is what the client gate reads.
  // Null on every non-courier account.
  @Field(() => String, { nullable: true })
  photoUrl?: string | null;

  @Field(() => CourierSelfieStatus, { nullable: true })
  selfieStatus?: CourierSelfieStatus | null;

  @Field(() => Date, { nullable: true })
  selfieVerifiedAt?: Date | null;

  @Field(() => String, { nullable: true })
  selfieRevokedReason?: string | null;

  // Self-service deletion lifecycle (see src/account-deletion/).
  @Field(() => AccountStatus, { nullable: true })
  accountStatus?: AccountStatus;

  @Field(() => Date, { nullable: true })
  deletionRequestedAt?: Date;

  @Field(() => Date, { nullable: true })
  deletionScheduledAt?: Date;

  @Field(() => Date, { nullable: true })
  deletionCancelledAt?: Date;

  @Field(() => Date, { nullable: true })
  deletedAt?: Date;

  @Field(() => Date, { nullable: true })
  anonymizedAt?: Date;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}
