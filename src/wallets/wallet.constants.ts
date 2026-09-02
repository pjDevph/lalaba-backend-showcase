/**
 * Wallet business constants — centralized per Phase 2 hardening.
 *
 * DECISION_REQUIRED-002 (docs/production-readiness/DECISIONS_REQUIRED.md) is
 * still OPEN: the peso amounts below are the shipped values, kept as-is and
 * centralized here so they exist in exactly one place. Do NOT change these
 * values without a resolution of DECISION_REQUIRED-002; when it resolves,
 * this file is the single edit point (or the place to swap in admin config).
 */

/**
 * ₱1,000 onboarding minimum. The first time a wallet's balance reaches this
 * amount, `activatedAt` is stamped — the payment-readiness marker consumed by
 * discovery/marketplace eligibility. (Previously inlined in
 * wallets.service.ts.)
 */
export const ACTIVATION_MIN_CENTAVOS = 100_000;

/**
 * ₱100 accept-a-booking minimum. A provider is only surfaced in discovery
 * while the wallet is activated AND holds at least this balance. (Previously
 * inlined in discovery.service.ts as ACCEPT_MIN_CENTAVOS.)
 */
export const DISCOVERY_ACCEPT_MIN_CENTAVOS = 10_000;

/**
 * Upper bound for a single top-up: ₱10,000,000 in centavos. Purely a sanity
 * cap against fat-finger/overflow input, not a product rule.
 */
export const MAX_TOPUP_CENTAVOS = 10_000_000_00;

/**
 * How many top-up attempts `topUpHistory` returns. Not a business rule (so not
 * covered by DECISION_REQUIRED-002) — a page size. The wallet screen shows a
 * recent-activity list, not an audit log, and every abandoned checkout leaves a
 * PENDING row behind, so an unbounded find over a hot branch is a slow query
 * any user can trigger just by tapping "Top up" and backing out.
 */
export const TOP_UP_HISTORY_LIMIT = 50;
