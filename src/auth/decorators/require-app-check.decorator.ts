import { SetMetadata } from '@nestjs/common';

export const REQUIRE_APP_CHECK = 'requireAppCheck';

/**
 * APPCHK-012 — demand a valid Firebase App Check attestation for this handler.
 *
 * Opt-IN, not global, and that is a deliberate architectural choice rather
 * than a staging step.
 *
 * The Admin Panel authenticates with Firebase Auth and calls the same
 * /graphql endpoint as the mobile apps, but it is a web client with no App
 * Check provider wired yet. A blanket "every GraphQL request needs App Check"
 * middleware would lock the back office out of provider suspension, wallet
 * adjustment and KYC decisions — while looking like a security improvement.
 *
 * The tempting shortcut is to exempt callers by a header like
 * `X-Client-Type: admin`. Don't: an attacker sets that header too, and it
 * converts the control into an honour system.
 *
 * So enforcement starts where the abuse actually is — the unauthenticated
 * mobile-only operations from the B3 finding — and widens to global only once
 * every first-party client, Admin Web included, is App Check enabled. See
 * APPCHK coverage matrix in PROD-READINESS.md.
 */
export const RequireAppCheck = () => SetMetadata(REQUIRE_APP_CHECK, true);
