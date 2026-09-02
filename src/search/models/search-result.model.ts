import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { MatchedOn, MatchStrength } from '../term.util';

registerEnumType(MatchedOn, { name: 'SearchMatchedOn' });
registerEnumType(MatchStrength, { name: 'SearchMatchStrength' });

/**
 * What kind of thing was found.
 *
 * Roles are split out rather than collapsed into one USER type: an operator
 * looking at a phone number needs to know immediately whether it belongs to a
 * customer, a provider or one of a merchant's branch staff, because the next
 * question is completely different in each case.
 *
 * BRANCH is separate from PROVIDER because a laundromat is a business with
 * several bookable branches, and the useful context for "Branch A is not
 * appearing in the marketplace" is the branch, not the owner's user record.
 * Home washers have exactly one anchor branch and no business above it — the
 * anchor exists so shared inventory/product code works unmodified — so for a
 * washer these two collapse to one thing, and the UI should not invent a
 * branch selector for her.
 */
export enum SearchEntityType {
  CUSTOMER = 'CUSTOMER',
  /**
   * An admin or support account. Findable — "who is the admin who published
   * this fee rule" is a real question — but never typed as a CUSTOMER, which
   * is what an unmapped role used to fall back to: the first end-to-end run of
   * this query returned the platform administrator as a customer.
   */
  BACK_OFFICE = 'BACK_OFFICE',
  PROVIDER = 'PROVIDER',
  BRANCH = 'BRANCH',
  STAFF = 'STAFF',
  COURIER = 'COURIER',
  ORDER = 'ORDER',
  TICKET = 'TICKET',
}
registerEnumType(SearchEntityType, { name: 'SearchEntityType' });

/**
 * The handful of numbers worth showing on a result row, so an operator can
 * pick the right one WITHOUT opening it.
 *
 * Everything here is cheap: counts already indexed, or a field already on the
 * document. Nothing that needs a join per row — a search box that costs one
 * aggregation per result is a search box nobody waits for.
 */
@ObjectType()
export class SearchResultContext {
  @Field(() => Int, { nullable: true })
  openOrders?: number;

  @Field(() => Int, { nullable: true })
  openTickets?: number;

  /** For a BRANCH: which business it belongs to. */
  @Field(() => String, { nullable: true })
  providerName?: string;

  /** Order status, ticket status, account status — whatever this row's is. */
  @Field(() => String, { nullable: true })
  status?: string;
}

@ObjectType()
export class SearchResult {
  @Field(() => SearchEntityType)
  entityType!: SearchEntityType;

  @Field(() => ID)
  id!: string;

  /** The name a human would call this thing. */
  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  subtitle?: string;

  @Field(() => MatchedOn)
  matchedOn!: MatchedOn;

  @Field(() => MatchStrength)
  matchStrength!: MatchStrength;

  @Field(() => SearchResultContext, { nullable: true })
  context?: SearchResultContext;
}

@ObjectType()
export class OperationalSearchResults {
  @Field(() => [SearchResult])
  results!: SearchResult[];

  /**
   * Which entity types were actually searched for THIS caller.
   *
   * Deliberately not a `permittedActions` list per result. The admin panel
   * already has a capability layer whose entire stated purpose is to mirror
   * these guards, and returning a second, backend-authored answer to the same
   * question would give the UI two sources of truth about what it may offer —
   * the exact failure capabilities.ts warns about. What the backend knows and
   * the panel cannot infer is which searchers it was allowed to RUN, so that
   * is what it returns: it lets the UI say "orders were not searched" instead
   * of the much worse "no orders found".
   */
  @Field(() => [SearchEntityType])
  searchedTypes!: SearchEntityType[];

  /**
   * True when a searcher hit its per-type cap. The UI says "showing the first
   * N" rather than implying the list is everything.
   */
  @Field()
  truncated!: boolean;
}
