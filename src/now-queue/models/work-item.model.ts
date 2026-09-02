import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';

/**
 * WHAT NEEDS SOMEONE, RIGHT NOW.
 *
 * The panel's home page was a wall of statistics: revenue today, provider
 * counts, a platform-status tile. Nobody opens an operations console to read
 * revenue — they open it because something is wrong. It could report the
 * health of the platform and could not answer "what should I do next", which
 * is the only question an operator actually arrives with.
 *
 * Every definition here is SERVER-SIDE, deliberately. "Stuck" and "overdue"
 * are operational facts about Lalaba, and the moment they live in React each
 * screen invents its own version — one page's two-hour threshold becomes
 * another's three, and neither is written down. The first-response clock in
 * particular already existed in SupportTicketsService with its own per-
 * priority targets; this reuses it rather than approximating it.
 *
 * WHAT THIS IS NOT: a queue engine. Nothing is written, nothing is claimed,
 * there is no queue table. Each source is a read over records that already
 * exist, composed in one place — which is all the first version needs and
 * leaves room for a real one if the volume ever justifies it.
 */

/**
 * The kinds of work. Named for the SITUATION rather than the collection —
 * ORDER_STUCK, not "online_orders row" — because the point of the page is that
 * an operator never has to know which collection a problem lives in.
 */
export enum WorkItemType {
  TICKET_OVERDUE = 'TICKET_OVERDUE',
  TICKET_UNASSIGNED = 'TICKET_UNASSIGNED',
  KYC_AWAITING_REVIEW = 'KYC_AWAITING_REVIEW',
  ORDER_STUCK = 'ORDER_STUCK',
  ORDER_UNSETTLED = 'ORDER_UNSETTLED',
  WALLET_VARIANCE = 'WALLET_VARIANCE',
}
registerEnumType(WorkItemType, { name: 'WorkItemType' });

export enum WorkPriority {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}
registerEnumType(WorkPriority, { name: 'WorkPriority' });

/** What the row points at, so the panel can build its own route. */
export enum WorkSubjectType {
  ORDER = 'ORDER',
  TICKET = 'TICKET',
  PERSON = 'PERSON',
  BRANCH = 'BRANCH',
  NONE = 'NONE',
}
registerEnumType(WorkSubjectType, { name: 'WorkSubjectType' });

@ObjectType()
export class WorkItem {
  @Field(() => ID) id!: string;

  @Field(() => WorkItemType) type!: WorkItemType;

  @Field(() => WorkPriority) priority!: WorkPriority;

  /** What the row is about — an order number, a ticket subject, a name. */
  @Field() title!: string;

  /**
   * Why it is here, in the operator's words. "Waiting for provider
   * acceptance", not "status = pending_provider_acceptance" — a row that
   * requires you to know the state machine has not saved you the lookup.
   */
  @Field() reason!: string;

  @Field(() => WorkSubjectType) subjectType!: WorkSubjectType;

  /**
   * The id to open. The panel builds the ROUTE itself: routes are a frontend
   * concern, and a backend that emits URLs becomes a second place where the
   * app's navigation is defined.
   */
  @Field(() => ID, { nullable: true }) subjectId?: string | null;

  /** When this became work — not when the record was created. */
  @Field(() => Date, { nullable: true }) enteredQueueAt?: Date | null;

  @Field(() => Int, { nullable: true }) ageMinutes?: number | null;

  /** When it was, or is, due. Null where the source has no target. */
  @Field(() => Date, { nullable: true }) dueAt?: Date | null;

  /** Positive means late. Negative is time remaining. */
  @Field(() => Int, { nullable: true }) overdueMinutes?: number | null;

  @Field(() => String, { nullable: true }) assigneeName?: string | null;

  /** Money at stake, where the item is about money. */
  @Field(() => Int, { nullable: true }) amountCentavos?: number | null;
}

@ObjectType()
export class NowQueue {
  @Field(() => [WorkItem]) items!: WorkItem[];

  /**
   * The kinds of work this caller was allowed to look for.
   *
   * Same reasoning as the search contract: a type that was never queried and a
   * type with nothing in it are indistinguishable in an empty list, and mean
   * opposite things. Without this the page tells a support agent the books are
   * clean when it simply never checked.
   */
  @Field(() => [WorkItemType]) searchedTypes!: WorkItemType[];

  /** True when a source hit its cap, so the page never implies completeness. */
  @Field() truncated!: boolean;

  /** When this was assembled — every number on the page is as of this moment. */
  @Field() generatedAt!: Date;
}
