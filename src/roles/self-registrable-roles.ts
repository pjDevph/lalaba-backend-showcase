/**
 * The roles a user may choose for THEMSELVES at sign-up.
 *
 * Single source of truth for two things that must never disagree:
 *
 *   1. `UsersService.registerUser` — rejects a registration whose role is not
 *      on this list ("This registration type is not supported.").
 *   2. The public `signupRoles` query (SEC-004) — the only role data exposed
 *      without a token, so the sign-up screens can resolve the Role `_id` they
 *      have to send before any token exists.
 *
 * Keeping the enforcement and the public projection on the same constant means
 * the public surface can never advertise a role registration would refuse, and
 * — far more importantly — adding a role here is a deliberate, greppable act
 * with a visible security consequence, not an accident.
 *
 * Deliberately EXCLUDED, and why:
 *   - staff, courier  — provisioned by a provider owner via createStaff. A
 *                       self-registrable courier could join a tenant uninvited.
 *   - admin, support  — provisioned via createAdminUser. Never self-service.
 */
export const SELF_REGISTRABLE_ROLE_IDS: readonly string[] = [
  'customer', // customer app
  'merchant', // partner app — laundromat owner
  'washer', // partner app — independent Home Washer
];
