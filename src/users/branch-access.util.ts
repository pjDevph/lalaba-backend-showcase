// The one writer for a staff member's grants.
//
// `User.branchAccess` is canonical; `User.branchIds` and `User.permissionIds`
// are mirrors derived from it. Three fields that must agree are three chances
// for them to drift, so nothing writes any of them directly — callers build the
// entries they want and hand them here, and the result is spread into a single
// `$set` so the trio is always written as a unit.
//
// Why a helper and not a Mongoose hook: every staff write in this repo goes
// through `findByIdAndUpdate({ $set })`, where `pre('save')` never fires. A
// `pre('findOneAndUpdate')` hook would have to reverse-engineer arbitrary
// update shapes, and would silently not run for the backfill migration's
// `bulkWrite` either.

import { Types } from 'mongoose';

/** A branch and the permissions granted on it, in whatever shape the caller has. */
export interface BranchAccessEntry {
  branchId: string | Types.ObjectId;
  permissionIds: readonly (string | Types.ObjectId)[];
}

/** The three fields, ready to spread into a `$set`. */
export interface DerivedGrantFields {
  branchAccess: { branchId: Types.ObjectId; permissionIds: Types.ObjectId[] }[];
  branchIds: Types.ObjectId[];
  permissionIds: Types.ObjectId[];
}

const toObjectId = (value: string | Types.ObjectId): Types.ObjectId =>
  value instanceof Types.ObjectId ? value : new Types.ObjectId(String(value));

/**
 * Build `branchAccess` plus its two derived mirrors from a set of entries.
 *
 * Repeated branches are merged rather than rejected: a caller assembling
 * entries from a form and a "same permissions as the first branch" default can
 * legitimately produce the same branch twice, and the union is the only sane
 * reading. Everything is cast to ObjectId — ids arrive as strings from GraphQL
 * input and as ObjectIds from a hydrated document, and Mongo will not match a
 * string against an ObjectId-typed field.
 */
export function deriveGrantFields(
  entries: readonly BranchAccessEntry[] | undefined | null,
): DerivedGrantFields {
  const byBranch = new Map<string, Set<string>>();

  for (const entry of entries ?? []) {
    const branchKey = String(entry.branchId);
    const grants = byBranch.get(branchKey) ?? new Set<string>();
    for (const permissionId of entry.permissionIds ?? []) {
      grants.add(String(permissionId));
    }
    byBranch.set(branchKey, grants);
  }

  const branchAccess = [...byBranch.entries()].map(([branchId, grants]) => ({
    branchId: toObjectId(branchId),
    permissionIds: [...grants].map(toObjectId),
  }));

  const union = new Set<string>();
  for (const grants of byBranch.values()) {
    for (const permissionId of grants) union.add(permissionId);
  }

  return {
    branchAccess,
    branchIds: [...byBranch.keys()].map(toObjectId),
    permissionIds: [...union].map(toObjectId),
  };
}

/**
 * The permission ids a staff member holds on one specific branch.
 *
 * Returns an empty array both for "no entry for this branch" and "an entry
 * granting nothing" — the caller must treat them identically, because both mean
 * the same thing to an authorization decision.
 */
export function grantsForBranch(
  branchAccess: readonly BranchAccessEntry[] | undefined | null,
  branchId: string | Types.ObjectId | null | undefined,
): string[] {
  if (!branchId) return [];
  const wanted = String(branchId);
  const entry = (branchAccess ?? []).find((e) => String(e.branchId) === wanted);
  return (entry?.permissionIds ?? []).map((id) => String(id));
}
