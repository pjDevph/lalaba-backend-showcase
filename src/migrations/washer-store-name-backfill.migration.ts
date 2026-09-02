import type { Connection } from 'mongoose';
import {
  defaultWasherStoreName,
  UNNAMED_WASHER_STORE_NAME,
} from '../washer/washer-name.util';

// ---------------------------------------------------------------------------
// Backfill WasherProfile.storeName.
//
// A home washer's shop is listed under `storeName` — the field she edits on the
// washer app's Online Store screen. It is required at every write path now
// (seeded at registration, unclearable through updateWasherProfile), but every
// washer who registered BEFORE the field existed has none, and the read layer
// no longer falls back to her `displayName`. Left alone those shops would list
// as the generic "Home Laundry", indistinguishable from each other.
//
// The name is taken from the washer's anchor Branch (`branchName`), which has
// carried "<First>'s Laundry" since registration for exactly this shape of
// data. Falling back, in order:
//
//   1. anchor Branch.branchName          — what registration generated
//   2. "<User.firstName>'s Laundry"      — same rule, recomputed
//   3. "<first word of displayName>'s Laundry"
//   4. "Home Laundry"                    — nothing usable to build from
//
// Her displayName is NEVER used whole: the point of the field is that a shop is
// not listed under a person's legal name.
//
// Idempotency: the filter matches only profiles with no usable storeName, so a
// second run matches nothing and reports 0.
// ---------------------------------------------------------------------------

// Explicit on the schemas — NOT Mongoose's pluralised defaults.
export const WASHER_PROFILES_COLLECTION = 'washer_profiles';
export const BRANCHES_COLLECTION = 'branches';
export const USERS_COLLECTION = 'users';

/** A profile needs a name if the field is absent, null, or whitespace-only. */
const NEEDS_NAME_FILTER = {
  $or: [
    { storeName: { $exists: false } },
    { storeName: null },
    { storeName: '' },
    { storeName: { $regex: '^\\s*$' } },
  ],
};

export type NameSource = 'branch' | 'firstName' | 'displayName' | 'generic';

export interface WasherStoreNameBackfillRow {
  id: string;
  uid: string;
  storeName: string;
  /** Which rule produced the name — logged so the run is auditable. */
  source: NameSource;
}

export interface WasherStoreNameBackfillResult {
  matched: number;
  updated: number;
  /** Every affected profile and the name it was (or would be) given. */
  affected: WasherStoreNameBackfillRow[];
}

export interface WasherStoreNameBackfillOptions {
  connection: Connection;
  /** false ⇒ dry run: count and list, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

export async function backfillWasherStoreName(
  options: WasherStoreNameBackfillOptions,
): Promise<WasherStoreNameBackfillResult> {
  const { connection, apply, log } = options;
  const profiles = connection.collection(WASHER_PROFILES_COLLECTION);
  const branches = connection.collection(BRANCHES_COLLECTION);
  const users = connection.collection(USERS_COLLECTION);

  const docs = await profiles.find(NEEDS_NAME_FILTER).toArray();

  // Rows keep their raw `_id` alongside the reported string form, so the write
  // below can address each document without re-parsing it back into an ObjectId.
  const planned: {
    _id: (typeof docs)[number]['_id'];
    row: WasherStoreNameBackfillRow;
  }[] = [];
  for (const doc of docs) {
    const branch = doc.branchId
      ? await branches.findOne({ _id: doc.branchId })
      : null;
    const branchName =
      typeof branch?.branchName === 'string' ? branch.branchName.trim() : '';

    let storeName = branchName;
    let source: NameSource = 'branch';

    if (!storeName) {
      const user = doc.uid ? await users.findOne({ _id: doc.uid }) : null;
      const firstName =
        typeof user?.firstName === 'string' ? user.firstName.trim() : '';
      if (firstName) {
        storeName = defaultWasherStoreName(firstName);
        source = 'firstName';
      }
    }

    if (!storeName) {
      // First word only — "Maria Dela Cruz" becomes "Maria's Laundry", never
      // her full legal name.
      const first =
        typeof doc.displayName === 'string'
          ? doc.displayName.trim().split(/\s+/)[0]
          : '';
      if (first) {
        storeName = defaultWasherStoreName(first);
        source = 'displayName';
      }
    }

    if (!storeName) {
      storeName = UNNAMED_WASHER_STORE_NAME;
      source = 'generic';
    }

    planned.push({
      _id: doc._id,
      row: { id: String(doc._id), uid: String(doc.uid), storeName, source },
    });
  }

  const affected = planned.map((p) => p.row);
  for (const row of affected) {
    log?.(
      `washer ${row.id} (uid ${row.uid}): storeName → "${row.storeName}" (from ${row.source})`,
    );
  }

  if (!apply) {
    return { matched: affected.length, updated: 0, affected };
  }

  let updated = 0;
  for (const { _id, row } of planned) {
    const res = await profiles.updateOne(
      // The filter is re-asserted per document, not just matched on _id: a
      // washer who names her own shop between the read above and this write
      // must not have it overwritten by a name derived from her branch.
      { _id, ...NEEDS_NAME_FILTER },
      { $set: { storeName: row.storeName } },
    );
    updated += res.modifiedCount ?? 0;
  }

  return { matched: affected.length, updated, affected };
}
