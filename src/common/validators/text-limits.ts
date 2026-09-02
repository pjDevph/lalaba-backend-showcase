// Maximum lengths for user-supplied free text.
//
// Every free-text field needs one. Without a cap a single request can store an
// arbitrarily large document, and the cost lands on every later read of it —
// the failure is slow and shared, not a crash you would notice in testing.
//
// These are deliberately generous: they exist to bound the worst case, not to
// second-guess someone writing a long complaint. A limit a real person hits is
// a bug in the limit.
//
// Note on the threat model: this stack is MongoDB + GraphQL, so SQL injection
// is not the risk here. What these guard against is unbounded storage; the
// separate concern is any user string reaching a query as a REGEX, which must
// be escaped at the query site (see escapeRegExp) rather than length-limited.
export const TEXT_LIMITS = {
  /** A line or two: a cancellation reason, a rating comment. */
  SHORT: 500,
  /** A paragraph: delivery instructions, care notes, a profile description. */
  MEDIUM: 1_000,
  /** Someone explaining a problem properly. Support bodies, broadcasts. */
  LONG: 5_000,
} as const;
