# Lalaba — Backend

The NestJS + GraphQL API behind Lalaba, a laundry marketplace connecting customers, laundromats, home washers, and platform staff. This is a public, redacted snapshot of the real codebase — see [Notes on this snapshot](#notes-on-this-snapshot).

One backend, three clients: the [Customer app](https://github.com/pjDevph/lalaba-customer-showcase), the [Partner app](https://github.com/pjDevph/lalaba-partner-showcase), and the [Admin panel](https://github.com/pjDevph/lalaba-admin-showcase) all talk to this API — no client computes its own prices, fees, or capacity.

| | |
|---|---|
| 🧩 **187** module directories | catalog, bookings, wallets, KYC, devices, promotions, reports, and more |
| 🔌 **57** GraphQL resolvers | Apollo Server on NestJS |
| 🗄️ **68** Mongoose schemas | MongoDB, with Redis for rate limiting/caching |
| 👥 Built with a small team | not a solo project — commits span backend, both mobile apps, and admin |

## Two things worth actually reading

**The Xendit wallet webhook can't double-credit.** `POST /webhooks/xendit` verifies the callback token with a SHA-256 hash + `timingSafeEqual` (no early-exit string comparison to leak timing info), validates the settled amount/currency against the stored top-up intent, then routes the actual credit through one transactional path guarded by a unique ledger index. A retried Xendit callback returns `alreadyPosted: true` instead of crediting twice. It also runs on its own rate-limit bucket, separate from interactive traffic — see the comment in [`src/wallets/xendit-webhook.controller.ts`](src/wallets/xendit-webhook.controller.ts) for why that split exists (a burst of legit settlements once tripped the *global* throttle and made Xendit's own retries the thing that starved every other route).

**Device approval is server state, not a client flag.** A staff device registers against a specific branch, an owner/admin approves or blocks it, and every check after that is gated to a single active session — see [`src/devices/devices.service.ts`](src/devices/devices.service.ts). There's also a backfill routine that normalizes devices created before the `status`/`activeSession` fields existed, so tightening the gate later didn't lock out every pre-existing device at once.

## Stack

NestJS 11 · Apollo GraphQL · Mongoose 9 · MongoDB · Redis (`ioredis`) · Firebase Admin SDK (Auth/App Check/Messaging) · Xendit (invoice + webhook)

## Notes on this snapshot

Single squashed commit, not the real project history (222 commits). Internal-only content was removed before publishing: security-audit docs (`docs/production-readiness/`, `docs/release-evidence/`) that listed specific known defects, internal phase-planning docs, deployment infra config (Railway/Render), and CI workflow files. No secrets were found in the real git history (verified with `gitleaks` across all commits) — the one flagged match was the stock NestJS README's CircleCI badge placeholder, not a credential.

---

Part of the Lalaba platform · built by [Prince John Gandollas](https://github.com/pjDevph) with a small engineering team
