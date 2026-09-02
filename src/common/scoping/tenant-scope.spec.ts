import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  applyBranchScope,
  branchClause,
  resolveTenantScope,
} from './tenant-scope';
import { User } from '../../users/schemas/user.schema';

/**
 * SEC-023/024/025 — regression tests for the intra-tenant branch escape.
 *
 * The first `describe` block is the vulnerability itself: before the fix, a
 * staff-supplied `branchId` bypassed the assignment check entirely. Each of
 * those cases fails against the old `if (branchId) … else if (branchIds.length)`
 * shape and passes against `branchClause`.
 */

const BRANCH_A = new Types.ObjectId().toHexString();
const BRANCH_B = new Types.ObjectId().toHexString();
const MERCHANT = new Types.ObjectId().toHexString();

const staff = (branchIds: unknown[], merchantId: string | null = MERCHANT) =>
  ({
    _id: 'staff-uid',
    merchantId,
    branchIds,
    role: { roleId: 'staff' },
  }) as unknown as User;

const owner = () =>
  ({
    _id: MERCHANT,
    branchIds: [],
    role: { roleId: 'merchant' },
  }) as unknown as User;

describe('branch escape (the original vulnerability)', () => {
  it('EC: staff naming a branch they are NOT assigned to is refused', () => {
    const scope = resolveTenantScope(staff([BRANCH_A]));
    expect(() => branchClause(scope, BRANCH_B)).toThrow(ForbiddenException);
  });

  it('EC: the refusal also covers the aggregate path (analytics)', () => {
    const scope = resolveTenantScope(staff([BRANCH_A]));
    const match: Record<string, unknown> = { paymentStatus: 'PAID' };
    expect(() => applyBranchScope(match, scope, BRANCH_B)).toThrow(
      ForbiddenException,
    );
    // and nothing was written to the query before it threw
    expect(match.branchId).toBeUndefined();
  });

  it('HP: staff naming a branch they ARE assigned to is allowed', () => {
    const scope = resolveTenantScope(staff([BRANCH_A, BRANCH_B]));
    expect(branchClause(scope, BRANCH_B)).toBe(BRANCH_B);
  });
});

describe('staff with multiple branches (SEC-025)', () => {
  it('HP: no branch requested falls back to exactly their assignment', () => {
    const scope = resolveTenantScope(staff([BRANCH_A, BRANCH_B]));
    expect(branchClause(scope)).toEqual({ $in: [BRANCH_A, BRANCH_B] });
  });

  it('HP: either assigned branch may be selected individually', () => {
    const scope = resolveTenantScope(staff([BRANCH_A, BRANCH_B]));
    expect(branchClause(scope, BRANCH_A)).toBe(BRANCH_A);
    expect(branchClause(scope, BRANCH_B)).toBe(BRANCH_B);
  });
});

describe('id shape normalization', () => {
  // user.branchIds is declared string[] but holds ObjectId on a hydrated
  // document. Comparing the two shapes with === never matches, which would
  // lock every staff member out of their own branches.
  it('EC: ObjectId assignment matches a string request', () => {
    const scope = resolveTenantScope(staff([new Types.ObjectId(BRANCH_A)]));
    expect(branchClause(scope, BRANCH_A)).toBe(BRANCH_A);
  });

  it('EC: ObjectId assignment still refuses an unassigned branch', () => {
    const scope = resolveTenantScope(staff([new Types.ObjectId(BRANCH_A)]));
    expect(() => branchClause(scope, BRANCH_B)).toThrow(ForbiddenException);
  });
});

describe('fail-closed defaults', () => {
  it('EC: staff with NO assigned branches sees nothing, not everything', () => {
    // The old shape read `else if (branchIds.length)`, so an empty assignment
    // applied no constraint at all and granted merchant-wide visibility.
    const scope = resolveTenantScope(staff([]));
    expect(branchClause(scope)).toEqual({ $in: [] });
  });

  it('EC: staff with no assignment cannot name a branch either', () => {
    const scope = resolveTenantScope(staff([]));
    expect(() => branchClause(scope, BRANCH_A)).toThrow(ForbiddenException);
  });

  it('EC: staff without a merchantId is refused rather than self-scoped', () => {
    expect(() => resolveTenantScope(staff([BRANCH_A], null))).toThrow(
      ForbiddenException,
    );
  });
});

describe('owner scope', () => {
  it('HP: an owner is unrestricted when no branch is requested', () => {
    const scope = resolveTenantScope(owner());
    expect(scope.allowedBranchIds).toBeNull();
    expect(branchClause(scope)).toBeUndefined();
  });

  it('HP: an owner may name any of their branches', () => {
    const scope = resolveTenantScope(owner());
    expect(branchClause(scope, BRANCH_A)).toBe(BRANCH_A);
  });

  it('HP: merchantId is the owner’s own id', () => {
    expect(resolveTenantScope(owner()).merchantId).toBe(MERCHANT);
  });

  it('HP: staff merchantId is the merchant they belong to (SEC-024)', () => {
    // Cross-merchant isolation is the `uid`/`merchantId` clause, not the
    // branch clause. Asserted here so a future refactor cannot quietly swap
    // a staff member's tenant for their own id.
    expect(resolveTenantScope(staff([BRANCH_A])).merchantId).toBe(MERCHANT);
  });
});

describe('applyBranchScope', () => {
  it('HP: leaves an existing branchId condition alone when unrestricted', () => {
    // ServicesService seeds `branchId: { $ne: null }` before scoping.
    const scope = resolveTenantScope(owner());
    const query = { uid: MERCHANT, branchId: { $ne: null } };
    applyBranchScope(query, scope);
    expect(query.branchId).toEqual({ $ne: null });
  });

  it('HP: overwrites it when a constraint does apply', () => {
    const scope = resolveTenantScope(staff([BRANCH_A]));
    const query: Record<string, unknown> = {
      uid: MERCHANT,
      branchId: { $ne: null },
    };
    applyBranchScope(query, scope);
    expect(query.branchId).toEqual({ $in: [BRANCH_A] });
  });
});
