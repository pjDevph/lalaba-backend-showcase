/**
 * What did the operator actually paste?
 *
 * One search box has to serve an agent holding whatever the caller read out —
 * an order number, a phone number, an email, a uid copied from another screen,
 * or a name. Classifying the term ONCE, up front, is what lets the searchers
 * below stay simple and lets results be ranked against each other: an exact
 * phone match on a customer outranks a fuzzy name match on a provider, and
 * neither knows about the other.
 *
 * Deliberately a pure function in its own file. The equivalent logic already
 * exists inside OnlineOrdersService.buildOrderSearchClause, where it is a
 * private method on a 3,000-line service and untestable on its own. This is
 * not a refactor of that — moving it would touch the order search path for no
 * behavioural gain — but it IS the version that gets tested, and the two agree
 * about Philippine phone numbers, order-number shape and uid shape by
 * construction rather than by luck.
 */

/** How the term matched. Drives ranking; see RANK below. */
export enum MatchedOn {
  ORDER_NUMBER = 'ORDER_NUMBER',
  TICKET_NUMBER = 'TICKET_NUMBER',
  PHONE = 'PHONE',
  EMAIL = 'EMAIL',
  UID = 'UID',
  REFERENCE = 'REFERENCE',
  NAME = 'NAME',
}

export enum MatchStrength {
  EXACT = 'EXACT',
  PREFIX = 'PREFIX',
  FUZZY = 'FUZZY',
}

export type TermShape = {
  raw: string;
  /** Trimmed and collapsed, the form every searcher should use. */
  normalized: string;
  /** "LB-000123" — only when the term unambiguously has that shape. */
  orderNumber: string | null;
  /** Ticket numbers are uppercased identifiers, matched exactly. */
  ticketNumber: string | null;
  /**
   * The last 10 digits, so 09171234567, +639171234567 and 9171234567 all
   * resolve to one person. Null unless the term really looks like a phone
   * number — "2024" is digits and is not a phone number.
   */
  phoneTail: string | null;
  email: string | null;
  /** 24-character hex — a Mongo ObjectId. */
  objectId: string | null;
  /**
   * A Firebase uid: ~28 alphanumerics, no spaces. Distinct from objectId
   * because `customer.uid` on an order is a Firebase uid and would never match
   * the ObjectId branch — the bug that made a pasted uid silently find
   * nothing.
   */
  firebaseUid: string | null;
  /** Anything can be tried as a name; this is just the cleaned term. */
  name: string;
};

const ORDER_NUMBER = /^lb-?(\d{1,6})$/i;
const TICKET_NUMBER = /^(?:tk|tkt)-?\d{1,8}$/i;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const FIREBASE_UID = /^[A-Za-z\d]{20,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPED = /^[\d\s()+-]+$/;

export function classifyTerm(raw: string): TermShape {
  const normalized = raw.trim().replace(/\s+/g, ' ');

  const orderMatch = ORDER_NUMBER.exec(normalized);
  const digits = normalized.replace(/\D/g, '');

  // Order before phone: "LB-000123" contains digits but is not a number
  // anyone can be called on.
  const orderNumber = orderMatch
    ? `LB-${orderMatch[1].padStart(6, '0')}`
    : null;

  const isObjectId = OBJECT_ID.test(normalized);

  return {
    raw,
    normalized,
    orderNumber,
    ticketNumber: TICKET_NUMBER.test(normalized)
      ? normalized.toUpperCase()
      : null,
    // 7 digits is the shortest thing worth treating as a number to call, and
    // the whole term has to LOOK like a phone number — an ObjectId is 24
    // characters of hex and would otherwise qualify on digit count alone.
    phoneTail:
      !orderNumber &&
      !isObjectId &&
      digits.length >= 7 &&
      PHONE_SHAPED.test(normalized)
        ? digits.slice(-10)
        : null,
    email: EMAIL.test(normalized) ? normalized.toLowerCase() : null,
    objectId: isObjectId ? normalized : null,
    // An ObjectId also satisfies the Firebase-uid shape, so it is excluded
    // here; the two are reported separately because they address different
    // fields.
    firebaseUid:
      !isObjectId && FIREBASE_UID.test(normalized) && /\d/.test(normalized)
        ? normalized
        : null,
    name: normalized,
  };
}

/**
 * Ranking ladder. Lower sorts first.
 *
 * Exact operational identifiers beat everything, because an agent who typed
 * one knows exactly what they are looking for — a name match that outranked a
 * pasted order number would be the search second-guessing the operator.
 */
const RANK: Record<string, number> = {
  [`${MatchedOn.ORDER_NUMBER}:${MatchStrength.EXACT}`]: 0,
  [`${MatchedOn.TICKET_NUMBER}:${MatchStrength.EXACT}`]: 1,
  [`${MatchedOn.PHONE}:${MatchStrength.EXACT}`]: 2,
  [`${MatchedOn.EMAIL}:${MatchStrength.EXACT}`]: 3,
  [`${MatchedOn.UID}:${MatchStrength.EXACT}`]: 4,
  [`${MatchedOn.REFERENCE}:${MatchStrength.EXACT}`]: 5,
  [`${MatchedOn.NAME}:${MatchStrength.EXACT}`]: 6,
};

/** Sort key for one result. Prefix and fuzzy fall below every exact match. */
export function rankOf(matchedOn: MatchedOn, strength: MatchStrength): number {
  const exact = RANK[`${matchedOn}:${strength}`];
  if (exact !== undefined) return exact;
  return strength === MatchStrength.PREFIX ? 50 : 100;
}

/**
 * How well `value` matches what was typed — used for name matches, where the
 * database can only tell us THAT it matched.
 */
export function strengthOfNameMatch(
  value: string | null | undefined,
  term: string,
): MatchStrength {
  if (!value) return MatchStrength.FUZZY;
  const a = value.trim().toLowerCase();
  const b = term.trim().toLowerCase();
  if (a === b) return MatchStrength.EXACT;
  if (a.startsWith(b)) return MatchStrength.PREFIX;
  return MatchStrength.FUZZY;
}

/** Escapes a term for use inside a RegExp. */
export function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
