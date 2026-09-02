import { ForbiddenException } from '@nestjs/common';
import { Role } from '../../users/schemas/role.schema';
import { User } from '../../users/schemas/user.schema';

/**
 * SEC-016 — the one place branch/tenant visibility is decided.
 *
 * Before this existed, five services each carried their own copy of:
 *
 *   if (branchId)                query.branchId = branchId;
 *   else if (branchIds.length)   query.branchId = { $in: branchIds };
 *
 * which reads as "filter by the requested branch, or fall back to the ones
 * you're assigned to". It actually means "a caller who names a branch is never
 * checked against their assignment at all" — a cashier assigned to one branch
 * could read another branch's orders, transactions, revenue and inventory by
 * changing one variable in the request. Cross-MERCHANT access was still blocked
 * by the `uid` clause, so this was intra-tenant, but it defeated the entire
 * point of branch assignment.
 *
 * The write paths never had the bug (see PosOrdersService.validateBranchForOrder
 * and OrderDashboardService.assertBranchAccess) — only the read paths. Five
 * copies meant five chances to get it wrong, so the fix is one helper rather
 * than five patches.
 */

/** Who the caller is, in the only two terms a query cares about. */
export interface TenantScope {
  /**
   * The merchant whose data this caller may see. For an owner that is their
   * own id; for staff it is the merchant they belong to. Always applied.
   */
  merchantId: string;
  /**
   * Branches the caller may read, or `null` for "no branch restriction" — an
   * owner, who may read every branch they own.
   *
   * An EMPTY ARRAY is meaningfully different from `null`: it is staff who have
   * been assigned no branches, and it must resolve to "nothing", not
   * "everything". The old code could not express that difference, so such a
   * staff member silently got merchant-wide visibility.
   */
  allowedBranchIds: string[] | null;
}

/**
 * Mongo ids arrive as ObjectId from a hydrated document and as string from a
 * serialized cache entry (and `user.branchIds` is declared `string[]` via an
 * `as unknown as` cast that is simply not true at runtime). Comparing the two
 * shapes with `===` silently never matches, which would lock every staff member
 * out rather than letting the wrong one in — a quieter bug, but still a bug.
 */
const asIds = (values: unknown): string[] =>
  Array.isArray(values) ? values.map((v) => String(v)) : [];

/** Read the caller's tenancy off the authenticated user document. */
export function resolveTenantScope(
  user: User,
  activeBranchId?: string | null,
): TenantScope {
  const role = user.role as unknown as Role;

  if (role?.roleId === 'staff') {
    if (!user.merchantId) {
      // GqlAuthGuard already rejects staff without a merchantId, so reaching
      // here means the guard was bypassed or the document is malformed. Fail
      // closed rather than defaulting merchantId to the staff's own id, which
      // would silently scope the query to a tenant that does not exist.
      throw new ForbiddenException('Your account setup is incomplete.');
    }
    // Narrow to the branch the caller is actually working.
    //
    // Permissions are granted per branch, and PermissionsGuard decides using
    // the branch this staff member's approved device is pinned to. Visibility
    // has to agree: a staff member assigned to Makati and BGC, working Makati,
    // holding Orders in Makati only, would otherwise pass the guard on their
    // Makati grant and then act on a BGC row. Gating and scoping must name the
    // same branch or neither means anything.
    //
    // Assignment is still checked — an active branch outside it yields `[]`
    // rather than access — so a stale device pinned to a revoked branch sees
    // nothing instead of everything.
    const assigned = asIds(user.branchIds);
    if (activeBranchId) {
      const active = String(activeBranchId);
      return {
        merchantId: user.merchantId,
        allowedBranchIds: assigned.includes(active) ? [active] : [],
      };
    }

    return {
      merchantId: user.merchantId,
      allowedBranchIds: assigned,
    };
  }

  return { merchantId: user._id, allowedBranchIds: null };
}

/**
 * The `branchId` clause for a Mongo query, given the caller's scope and the
 * branch they asked for (if any).
 *
 * Returns `undefined` when no branch constraint applies, so the caller can
 * leave whatever it already had on the field — `ServicesService` seeds
 * `branchId: { $ne: null }` before scoping and must keep it.
 *
 * @throws ForbiddenException when a restricted caller names a branch outside
 *         their assignment. Deliberately loud rather than silently narrowing:
 *         a staff member requesting another branch is either a UI bug worth
 *         seeing or someone probing, and both deserve a real signal.
 */
export function branchClause(
  scope: TenantScope,
  requestedBranchId?: string | null,
): string | { $in: string[] } | undefined {
  const { allowedBranchIds } = scope;

  if (requestedBranchId) {
    const requested = String(requestedBranchId);
    if (allowedBranchIds !== null && !allowedBranchIds.includes(requested)) {
      throw new ForbiddenException('You are not assigned to this branch.');
    }
    return requested;
  }

  // Unrestricted caller, no branch asked for — every branch they own.
  if (allowedBranchIds === null) return undefined;

  // Restricted caller, no branch asked for — exactly their assignment. An
  // empty assignment yields `{ $in: [] }`, which matches no document. That is
  // the intended fail-closed answer, not an oversight.
  return { $in: allowedBranchIds };
}

/**
 * Apply the branch constraint to a query object in place, leaving the field
 * untouched when there is no constraint. The common case at every call site.
 */
export function applyBranchScope<T extends Record<string, unknown>>(
  query: T,
  scope: TenantScope,
  requestedBranchId?: string | null,
): T {
  const clause = branchClause(scope, requestedBranchId);
  if (clause !== undefined) {
    (query as Record<string, unknown>).branchId = clause;
  }
  return query;
}
