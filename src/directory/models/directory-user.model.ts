import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

/**
 * One account as the back office sees it, across every role.
 *
 * Deliberately not `UserType`: that model is shaped by what the apps need and
 * carries fields (tokens, consents) an admin list has no business paging
 * through. This is a projection built for scanning.
 */
@ObjectType()
export class DirectoryUser {
  @Field(() => ID)
  uid!: string;

  @Field()
  displayName!: string;

  @Field({ nullable: true })
  email?: string;

  @Field({ nullable: true })
  phoneNumber?: string;

  @Field()
  roleId!: string;

  @Field()
  roleName!: string;

  @Field()
  isActive!: boolean;

  /** ACTIVE | DELETION_PENDING | … — a deactivated account is not always banned. */
  @Field({ nullable: true })
  accountStatus?: string;

  /** WASHER accounts only: ACTIVE | INACTIVE | SUSPENDED. */
  @Field({ nullable: true })
  washerStatus?: string;

  /** COURIER accounts only: ACTIVE | REVOKED | null. */
  @Field({ nullable: true })
  selfieStatus?: string;

  /**
   * How many OTHER accounts share this phone number.
   *
   * The one multi-accounting signal available across every role — devices are
   * only registered for merchants and staff, so they cannot serve as a
   * universal one. Non-zero is a flag for a human, never grounds on its own:
   * families share numbers, and a provider re-registering as a customer is
   * legitimate.
   */
  @Field(() => Int)
  sharedPhoneCount!: number;

  @Field({ nullable: true })
  createdAt?: Date;
}

@ObjectType()
export class PaginatedDirectoryUsers {
  @Field(() => [DirectoryUser]) data!: DirectoryUser[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}

/** An account sharing an identifier with the one being viewed. */
@ObjectType()
export class LinkedAccount {
  @Field(() => ID) uid!: string;
  @Field() displayName!: string;
  @Field() roleId!: string;
  @Field() isActive!: boolean;
  /** What they share — currently only PHONE. */
  @Field() matchedOn!: string;
  @Field({ nullable: true }) createdAt?: Date;
}

/** A device registered against this account. Merchant/staff accounts only. */
@ObjectType()
export class DirectoryDevice {
  @Field(() => ID) deviceId!: string;
  @Field() deviceName!: string;
  @Field() operatingSystem!: string;
  @Field({ nullable: true }) deviceModel?: string;
  @Field() status!: string;
  @Field({ nullable: true }) staffName?: string;
  @Field({ nullable: true }) createdAt?: Date;
}

@ObjectType()
export class DirectoryUserDetail {
  @Field(() => DirectoryUser)
  user!: DirectoryUser;

  /** Orders this account PLACED. Zero for a provider who never buys laundry. */
  @Field(() => Int)
  ordersAsCustomer!: number;

  /** Orders this account FULFILLED. Zero for a customer. */
  @Field(() => Int)
  ordersAsProvider!: number;

  @Field(() => Int)
  ticketsRaised!: number;

  @Field({ nullable: true })
  lastOrderAt?: Date;

  /**
   * Wallet balance, for accounts that have one. Null — not zero — when the
   * account has no wallet at all: a customer's "zero balance" would otherwise
   * read as a provider who has run out of money.
   */
  @Field(() => Int, { nullable: true })
  walletBalanceCentavos?: number;

  @Field(() => [DirectoryDevice])
  devices!: DirectoryDevice[];

  @Field(() => [LinkedAccount])
  linkedAccounts!: LinkedAccount[];

  /**
   * Every session issued before this instant is rejected. Null means sessions
   * have never been force-ended for this account.
   */
  @Field({ nullable: true })
  sessionsValidAfter?: Date;
}

/**
 * A one-time credential letting an admin sign in as this account.
 *
 * Firebase's own constraint, not ours: a custom token must be EXCHANGED for a
 * real session within roughly an hour of minting, or it stops working. There
 * is no server-side way to shorten that further — the bound on how long an
 * impersonation session can then last is `revokeSessions` (force logout),
 * which already exists for exactly this kind of "end this session now" need.
 */
@ObjectType()
export class ImpersonationToken {
  @Field()
  customToken!: string;

  @Field(() => ID)
  targetUid!: string;

  @Field()
  targetName!: string;

  /** Which client app this account signs into — tells the admin what to open. */
  @Field()
  targetRoleId!: string;
}
