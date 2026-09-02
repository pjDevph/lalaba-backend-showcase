import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { STAFF_DEFAULT_PERMISSION_NAMES } from '../permissions/role-defaults';
import {
  PERMISSION_GROUP_MEMBERS,
  expandGroups,
  groupsFromNames,
} from '../permissions/permission-groups';
import { deriveGrantFields } from '../users/branch-access.util';

// ---------------------------------------------------------------------------
// Backfill User.branchAccess for staff and couriers.
//
// Permissions used to be account-global: one `permissionIds` list per staff
// member, unrelated to the branches they were assigned. They are now granted
// per branch, and `PermissionsGuard` reads only the entry for the branch the
// caller's device is pinned to. A staff document with no `branchAccess` would
// therefore hold nothing anywhere.
//
// Each staff member's existing grants are copied onto EVERY branch they are
// assigned to, which reproduces account-global semantics exactly — nobody gains
// or loses access on the day this runs.
//
// Two things get folded in on the way:
//
//   1. THE OLD IMPLICIT FLOOR. `order_confirm_pickup`, `order_update_status`
//      and `inventory_edit` were granted to every staff account by the guard
//      itself, without ever being stored. That floor is deleted, so unless they
//      are written down here every existing staff member loses them.
//
//   2. GROUP EXPANSION (default, --exact to disable). The owner-facing UI is
//      four switches, and a switch cannot render "confirm pickup but not
//      cancel" — which is precisely the shape the floor left behind. Holding
//      ANY member of a group therefore reads back as the whole group, so the
//      stored grant is widened to match rather than letting the UI overstate
//      what someone can do.
//
//      This WIDENS PRIVILEGE. A staff member who held only the floor gains
//      order_create, order_apply_discount and order_cancel, and the three
//      product permissions. The dry run prints exactly who gains what so that
//      is a decision, not a surprise.
//
// Couriers get an entry per branch granting nothing: they hold no merchant
// permissions by design, and this keeps `branchIds` a true mirror so
// `assertAssignableCourier` keeps working.
//
// Staff assigned to no branches get `branchAccess: []` and can do nothing —
// already the documented fail-closed meaning of an empty assignment.
//
// Idempotency: only documents with no `branchAccess` array are matched, so a
// second run reports 0.
// ---------------------------------------------------------------------------

export const USERS_COLLECTION = 'users';
export const ROLES_COLLECTION = 'roles';
export const PERMISSIONS_COLLECTION = 'permissions';

/** Roles whose grants live per branch. Couriers are included for the mirror. */
export const GRANT_BEARING_ROLE_IDS = ['staff', 'courier'] as const;

export interface BranchAccessBackfillRow {
  uid: string;
  roleId: string;
  branchCount: number;
  /** Permission names written toeach branch. */
  granted: string[];
  /** Names this user did not hold before, i.e. what group expansion added. */
  gained: string[];
}

export interface BranchAccessBackfillResult {
  matched: number;
  updated: number;
  rows: BranchAccessBackfillRow[];
  /** permissionName -> how many users gain it. Read this before --apply. */
  escalations: Record<string, number>;
}

export interface BranchAccessBackfillOptions {
  connection: Connection;
  apply?: boolean;
  /** Preserve exact grant sets instead of widening to whole groups. */
  exact?: boolean;
  log?: (message: string) => void;
}

export async function backfillBranchAccess({
  connection,
  apply = false,
  exact = false,
  log = () => {},
}: BranchAccessBackfillOptions): Promise<BranchAccessBackfillResult> {
  const db = connection.db;
  if (!db) throw new Error('No database handle on the connection');

  const roles = await db
    .collection(ROLES_COLLECTION)
    .find({ roleId: { $in: [...GRANT_BEARING_ROLE_IDS] } })
    .toArray();
  const roleIdById = new Map(roles.map((r) => [String(r._id), r.roleId]));
  if (!roles.length) {
    log('No staff or courier roles found — nothing to do.');
    return { matched: 0, updated: 0, rows: [], escalations: {} };
  }

  const permissions = await db
    .collection(PERMISSIONS_COLLECTION)
    .find({})
    .toArray();
  const idByName = new Map(permissions.map((p) => [p.permissionName, p._id]));
  const nameById = new Map(
    permissions.map((p) => [String(p._id), p.permissionName as string]),
  );

  const users = await db
    .collection(USERS_COLLECTION)
    .find({
      role: { $in: roles.map((r) => r._id) },
      branchAccess: { $exists: false },
    })
    .toArray();

  const rows: BranchAccessBackfillRow[] = [];
  const escalations: Record<string, number> = {};
  let updated = 0;

  for (const user of users) {
    const roleId = roleIdById.get(String(user.role)) ?? 'unknown';
    const branchIds: unknown[] = Array.isArray(user.branchIds)
      ? user.branchIds
      : [];

    let granted: string[] = [];
    let gained: string[] = [];

    if (roleId === 'staff') {
      const held = (Array.isArray(user.permissionIds) ? user.permissionIds : [])
        .map((id: unknown) => nameById.get(String(id)))
        .filter((n): n is string => !!n);

      // The floor was real access even though it was never stored.
      const before = new Set([...held, ...STAFF_DEFAULT_PERMISSION_NAMES]);
      granted = exact
        ? [...before]
        : expandGroups(groupsFromNames([...before]));
      gained = granted.filter((name) => !before.has(name));
      for (const name of gained) {
        escalations[name] = (escalations[name] ?? 0) + 1;
      }
    }

    const permissionIds = granted
      .map((name) => idByName.get(name))
      .filter((id): id is Types.ObjectId => !!id);

    const fields = deriveGrantFields(
      branchIds.map((branchId) => ({
        branchId: branchId as Types.ObjectId,
        permissionIds,
      })),
    );

    rows.push({
      uid: String(user._id),
      roleId,
      branchCount: fields.branchIds.length,
      granted,
      gained,
    });

    if (apply) {
      await db
        .collection(USERS_COLLECTION)
        .updateOne({ _id: user._id }, { $set: fields });
      updated += 1;
    }
  }

  for (const row of rows) {
    log(
      `${row.roleId} ${row.uid}: ${row.branchCount} branch(es), ` +
        `${row.granted.length} permission(s)` +
        (row.gained.length ? ` (+${row.gained.join(', ')})` : ''),
    );
  }

  const escalated = Object.entries(escalations);
  if (escalated.length) {
    log('');
    log('PRIVILEGE WIDENED by group expansion (re-run with --exact to avoid):');
    for (const [name, count] of escalated.sort((a, b) => b[1] - a[1])) {
      log(`  ${name}: ${count} staff gain this`);
    }
  }

  return { matched: users.length, updated, rows, escalations };
}

/** Exposed for the CLI's summary line. */
export const GROUP_MEMBER_COUNTS = Object.fromEntries(
  Object.entries(PERMISSION_GROUP_MEMBERS).map(([g, m]) => [g, m.length]),
);
