import { Types } from 'mongoose';
import { deriveGrantFields, grantsForBranch } from './branch-access.util';

const branchA = new Types.ObjectId();
const branchB = new Types.ObjectId();
const permOne = new Types.ObjectId();
const permTwo = new Types.ObjectId();

describe('deriveGrantFields', () => {
  it('mirrors branchIds from the entries', () => {
    const out = deriveGrantFields([
      { branchId: branchA, permissionIds: [permOne] },
      { branchId: branchB, permissionIds: [permTwo] },
    ]);
    expect(out.branchIds.map(String)).toEqual([
      String(branchA),
      String(branchB),
    ]);
  });

  it('mirrors permissionIds as the union across branches', () => {
    const out = deriveGrantFields([
      { branchId: branchA, permissionIds: [permOne] },
      { branchId: branchB, permissionIds: [permOne, permTwo] },
    ]);
    expect(out.permissionIds.map(String).sort()).toEqual(
      [String(permOne), String(permTwo)].sort(),
    );
  });

  it('keeps each branch grant separate — the union is not written back down', () => {
    const out = deriveGrantFields([
      { branchId: branchA, permissionIds: [permOne] },
      { branchId: branchB, permissionIds: [permTwo] },
    ]);
    expect(out.branchAccess[0].permissionIds.map(String)).toEqual([
      String(permOne),
    ]);
    expect(out.branchAccess[1].permissionIds.map(String)).toEqual([
      String(permTwo),
    ]);
  });

  it('casts string ids to ObjectId', () => {
    const out = deriveGrantFields([
      { branchId: String(branchA), permissionIds: [String(permOne)] },
    ]);
    expect(out.branchAccess[0].branchId).toBeInstanceOf(Types.ObjectId);
    expect(out.branchAccess[0].permissionIds[0]).toBeInstanceOf(Types.ObjectId);
    expect(out.branchIds[0]).toBeInstanceOf(Types.ObjectId);
  });

  it('merges a branch listed twice rather than emitting it twice', () => {
    const out = deriveGrantFields([
      { branchId: branchA, permissionIds: [permOne] },
      { branchId: String(branchA), permissionIds: [permTwo] },
    ]);
    expect(out.branchAccess).toHaveLength(1);
    expect(out.branchAccess[0].permissionIds.map(String).sort()).toEqual(
      [String(permOne), String(permTwo)].sort(),
    );
  });

  it('de-duplicates a permission repeated on one branch', () => {
    const out = deriveGrantFields([
      { branchId: branchA, permissionIds: [permOne, String(permOne)] },
    ]);
    expect(out.branchAccess[0].permissionIds).toHaveLength(1);
  });

  it('returns empty fields for no entries', () => {
    for (const input of [[], undefined, null]) {
      expect(deriveGrantFields(input)).toEqual({
        branchAccess: [],
        branchIds: [],
        permissionIds: [],
      });
    }
  });

  it('keeps a branch that grants nothing — assignment without permissions is a courier', () => {
    const out = deriveGrantFields([{ branchId: branchA, permissionIds: [] }]);
    expect(out.branchIds.map(String)).toEqual([String(branchA)]);
    expect(out.permissionIds).toEqual([]);
  });
});

describe('grantsForBranch', () => {
  const access = [
    { branchId: branchA, permissionIds: [permOne] },
    { branchId: branchB, permissionIds: [] },
  ];

  it('returns only that branch grants', () => {
    expect(grantsForBranch(access, branchA)).toEqual([String(permOne)]);
  });

  it('matches across string/ObjectId shapes', () => {
    expect(grantsForBranch(access, String(branchA))).toEqual([String(permOne)]);
  });

  it('returns empty for a branch with an empty grant', () => {
    expect(grantsForBranch(access, branchB)).toEqual([]);
  });

  it('returns empty for a branch with no entry, and for a missing branch', () => {
    expect(grantsForBranch(access, new Types.ObjectId())).toEqual([]);
    expect(grantsForBranch(access, null)).toEqual([]);
    expect(grantsForBranch(undefined, branchA)).toEqual([]);
  });
});
