import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';

/**
 * ONE SUBJECT, ASSEMBLED — the read model behind the unified workspace.
 *
 * The panel represented the same person four times in four shapes: a row in
 * the account directory, a party on an order, a requester on a ticket, a
 * participant in a chat. Nothing linked them, so "this customer has three
 * tickets and an unpaid order" was a question the back office could not
 * answer without four searches.
 *
 * Two things this is deliberately NOT:
 *
 *   It is not a `Case` collection. Nothing is written. Lalaba has no case
 *   management, and inventing a fifth representation of a person to fix the
 *   problem of having four would be a poor trade. This is a projection over
 *   records that already exist.
 *
 *   It is not universal access. ONE CONTEXT IS NOT ONE PERMISSION. Every
 *   module below is authorized on its own, and a module the caller may not see
 *   is not fetched — it comes back null and is absent from `modules`. The
 *   wallet is the live example: wallet reads are admin-only, so a support
 *   agent gets this page with everything except the money.
 */

/**
 * What kind of thing the context is about.
 *
 * PROVIDER and BRANCH are separate because a laundromat is a business with
 * several bookable branches, and "Branch A is not appearing in the
 * marketplace" is a question about the branch. A home washer is different: she
 * has exactly one anchor branch, created so the shared inventory/product
 * schema works unmodified, and no business entity above it. Modelling both the
 * same way would produce a branch selector that means nothing for half the
 * providers on the platform.
 */
export enum ContextSubjectType {
  PERSON = 'PERSON',
  BRANCH = 'BRANCH',
}
registerEnumType(ContextSubjectType, { name: 'ContextSubjectType' });

/**
 * Module keys. Strings rather than an enum on purpose — the panel matches
 * these against its own capability map, and the two lists are maintained
 * independently by design.
 */
export enum ContextModuleKey {
  IDENTITY = 'IDENTITY',
  ORDERS = 'ORDERS',
  TICKETS = 'TICKETS',
  WALLET = 'WALLET',
  KYC = 'KYC',
  BRANCHES = 'BRANCHES',
  STAFF = 'STAFF',
}
registerEnumType(ContextModuleKey, { name: 'ContextModuleKey' });

@ObjectType()
export class ContextIdentity {
  @Field(() => ID) id!: string;
  @Field() displayName!: string;
  @Field(() => String, { nullable: true }) email?: string | null;
  @Field(() => String, { nullable: true }) phone?: string | null;
  /** The account's role id — customer, washer, merchant, staff, courier… */
  @Field(() => String, { nullable: true }) roleId?: string | null;
  @Field() isActive!: boolean;
  @Field(() => String, { nullable: true }) accountStatus?: string | null;
  @Field(() => Date, { nullable: true }) joinedAt?: Date | null;
  /** For a BRANCH subject: the branch's own name. */
  @Field(() => String, { nullable: true }) branchName?: string | null;
}

@ObjectType()
export class ContextOrderRow {
  @Field(() => ID) id!: string;
  @Field(() => String, { nullable: true }) orderNumber?: string | null;
  @Field() status!: string;
  @Field() counterpartyName!: string;
  @Field(() => Int) totalCentavos!: number;
  @Field(() => Int) collectedCentavos!: number;
  @Field(() => Date, { nullable: true }) createdAt?: Date | null;
}

@ObjectType()
export class ContextOrders {
  @Field(() => Int) total!: number;
  @Field(() => Int) open!: number;
  /** Unsettled money across every order — the number support is chasing. */
  @Field(() => Int) outstandingCentavos!: number;
  @Field(() => [ContextOrderRow]) recent!: ContextOrderRow[];
}

@ObjectType()
export class ContextTicketRow {
  @Field(() => ID) id!: string;
  @Field(() => String, { nullable: true }) ticketNumber?: string | null;
  @Field() subject!: string;
  @Field() status!: string;
  @Field() priority!: string;
  @Field(() => Date, { nullable: true }) createdAt?: Date | null;
}

@ObjectType()
export class ContextTickets {
  @Field(() => Int) total!: number;
  @Field(() => Int) open!: number;
  @Field(() => [ContextTicketRow]) recent!: ContextTicketRow[];
}

@ObjectType()
export class ContextWallet {
  @Field(() => ID) branchId!: string;
  @Field(() => Int) balanceCentavos!: number;
  @Field() activated!: boolean;
}

@ObjectType()
export class ContextKycDocument {
  @Field(() => ID) id!: string;
  @Field() documentType!: string;
  @Field() status!: string;
  @Field(() => Date, { nullable: true }) submittedAt?: Date | null;
}

@ObjectType()
export class ContextKyc {
  @Field(() => Int) submitted!: number;
  @Field(() => Int) approved!: number;
  @Field(() => Int) rejected!: number;
  @Field(() => [ContextKycDocument]) documents!: ContextKycDocument[];
}

@ObjectType()
export class ContextBranch {
  @Field(() => ID) id!: string;
  @Field() branchName!: string;
  @Field() isActive!: boolean;
}

@ObjectType()
export class ContextStaffMember {
  @Field(() => ID) id!: string;
  @Field() displayName!: string;
  @Field(() => String, { nullable: true }) email?: string | null;
  @Field() isActive!: boolean;
}

@ObjectType()
export class OperationalContext {
  @Field(() => ContextSubjectType) subjectType!: ContextSubjectType;

  /** Always present — it is what makes the page addressable. */
  @Field(() => ContextIdentity) identity!: ContextIdentity;

  /**
   * The modules actually assembled for THIS caller.
   *
   * The distinction that makes the page honest: a module missing because the
   * caller may not see it and a module missing because the subject has none
   * look identical in the payload, and mean completely different things. A UI
   * that cannot tell them apart shows "no wallet" to a support agent who
   * simply is not allowed to look at one.
   */
  @Field(() => [ContextModuleKey]) modules!: ContextModuleKey[];

  @Field(() => ContextOrders, { nullable: true }) orders?: ContextOrders;
  @Field(() => ContextTickets, { nullable: true }) tickets?: ContextTickets;
  @Field(() => ContextWallet, { nullable: true }) wallet?: ContextWallet;
  @Field(() => ContextKyc, { nullable: true }) kyc?: ContextKyc;
  @Field(() => [ContextBranch], { nullable: true }) branches?: ContextBranch[];
  @Field(() => [ContextStaffMember], { nullable: true })
  staff?: ContextStaffMember[];
}
