import { Model } from 'mongoose';
import { Permission, PermissionDocument } from './schemas/permission.schema';
import { OWNER_DEFAULT_PERMISSION_NAMES } from './role-defaults';

/**
 * The set of permission names an account effectively holds.
 *
 * This is the READ-side twin of PermissionsGuard. The guard answers "may this
 * account do X?" for a required set; this answers "what may this account do?"
 * so a query can FILTER rows by permission instead of rejecting a call.
 *
 * The two agree for single-permission checks, which is the only way the feed
 * uses it — a notification carries at most one `requiredPermission`. They are
 * deliberately NOT interchangeable for multi-permission checks: the guard
 * applies its owner floor with `.every()` (SEC-009 — an implicit floor may only
 * fire when it covers the WHOLE requirement) and its explicit grants with OR.
 * Flattening both into one set would lose that distinction, so do not reach for
 * this function to replace a guard.
 *
 * `grants` is BRANCH-SCOPED for staff: pass the permissionIds from the
 * branchAccess entry for the branch in question, never the account-global
 * union. Passing the union would answer "may they do this somewhere", which is
 * how a Makati grant used to surface BGC notifications.
 *
 * Kept beside role-defaults.ts rather than in the guard so both callers import
 * the same implementation. Two hand-written answers to "what can this account
 * do" would drift, and the drift would be invisible: rows silently missing from
 * a feed, never an error.
 */
export async function resolveGrantedPermissionNames(
  roleId: string | undefined,
  grants: readonly string[] | undefined,
  permissionModel: Model<PermissionDocument>,
): Promise<Set<string>> {
  const granted = new Set<string>();

  // Role floors — owners carry no permissionIds of their own, so this is what
  // keeps them working at all.
  //
  // Staff have no floor any more — every capability they hold is an explicit
  // per-branch grant, so an ungranted branch yields an empty set and sees only
  // the notifications addressed to everyone.
  if (roleId === 'merchant') {
    for (const name of OWNER_DEFAULT_PERMISSION_NAMES) granted.add(name);
  }

  // Explicit grants ADD to the floor, never replace it.
  if (grants?.length) {
    const rows = await permissionModel
      // `_id` types as `string & ObjectId` on this schema while User stores
      // permissionIds as plain strings, so the filter needs a cast. The guard
      // gets away without one only because its `req.user` is untyped.
      .find({
        _id: { $in: [...grants] },
      } as unknown as Record<string, unknown>)
      .select('permissionName')
      .lean()
      .exec();
    for (const row of rows) {
      if (row.permissionName) granted.add(row.permissionName);
    }
  }

  return granted;
}

/** Re-exported so callers need only one import to reason about the floors. */
export { Permission };
