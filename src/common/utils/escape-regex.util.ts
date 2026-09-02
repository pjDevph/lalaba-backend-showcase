/**
 * API-001 — the one escape used before any user input reaches a RegExp.
 *
 * Fifteen services each carry their own inline copy of this expression, and
 * three call sites had no escape at all:
 *
 *   new RegExp(`^${input.branchName.trim()}$`, 'i')
 *
 * Two separate failures come out of that. A branch named `.*` matches every
 * existing branch, so the duplicate-name check rejects names that are in fact
 * free — a correctness bug the user sees as "that name is taken" for names
 * nobody has. And a nested-quantifier name like `(a+)+$` is a catastrophic
 * backtracking payload: one request pins a CPU core for as long as the engine
 * keeps trying, which is a denial of service that costs the caller nothing.
 *
 * Escaping is the whole fix. Anchoring alone is not — `^` and `$` bound where
 * the match starts and ends, not what the pattern between them can do.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A case-insensitive exact-match pattern for a user-supplied string — the
 * shape every duplicate-name check in the codebase actually wants.
 *
 * Prefer this over hand-writing `new RegExp('^' + escapeRegex(x) + '$', 'i')`:
 * the bug being fixed here was someone writing that line and leaving out the
 * middle of it, and a named helper has no middle to leave out.
 */
export function exactMatchInsensitive(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}
