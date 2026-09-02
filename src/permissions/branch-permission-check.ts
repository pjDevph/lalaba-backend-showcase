// The one implementation of "does this staff member hold X on that branch?".
//
// Two callers need this answer and must not disagree: `PermissionsGuard`, which
// gates whole resolvers, and the handful of in-service checks that gate one
// field of one mutation (POS discounts). It is a plain function taking the
// Permission model rather than an injectable service because the guard is
// registered as a provider in seven feature modules; a service would mean
// importing PermissionsModule into every one of them to change one query.

import { Model } from 'mongoose';
import { PermissionDocument } from './schemas/permission.schema';
import { grantsForBranch } from '../users/branch-access.util';

/** Just enough of a user document to make an authorization decision. */
export interface GrantHolder {
  branchAccess?: { branchId: unknown; permissionIds: unknown[] }[];
  permissionIds?: unknown[];
}

/**
 * Whether `user` holds ANY of `required` on `branchId`.
 *
 * ANY, not ALL: OR across the required list is the documented meaning of an
 * explicit grant, preserved from the pre-branch guard. A decorator naming two
 * permissions is asking "may they do this by either route?".
 *
 * Returns false whenever the branch is unknown or ungranted — the two are the
 * same answer to an authorization question, and both must fail closed.
 */
export async function holdsOnBranch(
  permissionModel: Model<PermissionDocument>,
  user: GrantHolder | null | undefined,
  branchId: string | null | undefined,
  required: readonly string[],
): Promise<boolean> {
  if (!user || !branchId || !required.length) return false;

  const granted = new Set(
    grantsForBranch(user.branchAccess as never, branchId),
  );
  if (!granted.size) return false;

  // Look the required names up and compare ids in memory rather than sending
  // the grant list into an `_id: { $in: ... }` clause. `required` is a handful
  // of names off an indexed unique field, the grant list is unbounded, and this
  // sidesteps the string/ObjectId casting that has already bitten branch
  // comparisons elsewhere in this codebase.
  const rows = await permissionModel
    .find({ permissionName: { $in: [...required] } })
    .select('_id')
    .lean()
    .exec();

  return rows.some((row) => granted.has(String(row._id)));
}

/**
 * True for a staff document written before per-branch grants existed.
 *
 * ROLLOUT ONLY. Cached user documents outlive a deploy, and one written before
 * the backfill has no `branchAccess` at all — denying those would sign out
 * every staff member for the length of the user-cache TTL. Such a document
 * falls back to the account-global union for one release. A staff member who
 * genuinely holds nothing on any branch has `branchAccess: []`, which is a
 * grant of nothing and is NOT this case.
 *
 * DELETE THIS, and its call site in PermissionsGuard, one release after the
 * backfill migration has run in production.
 */
export function predatesBranchAccess(
  user: GrantHolder | null | undefined,
): boolean {
  return !!user && user.branchAccess === undefined;
}
