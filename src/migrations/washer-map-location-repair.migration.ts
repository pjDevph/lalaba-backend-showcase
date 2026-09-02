import type { Connection } from 'mongoose';

// ---------------------------------------------------------------------------
// WasherProfile.mapLocation is nullable in the SDL, but the MapLocation type
// it points at declares `latitude: Float!` and `longitude: Float!`. A stored
// pin is therefore legal in exactly two shapes:
//
//   mapLocation: null                              — no pin set
//   mapLocation: { latitude: n, longitude: n }     — a complete pin
//
// Documents carrying the object WITHOUT usable coordinates ({}, a null
// latitude, a string, NaN) are unrepresentable. GraphQL answers any query that
// selects the field with
//
//   "Cannot return null for non-nullable field MapLocation.latitude."
//
// and — because the client treats a populated errors[] as a failed request —
// that takes down every read of the washer's profile, not merely the pin. The
// service now normalises on read (washer.service.ts normalizeMapLocation) and
// rejects partial writes; this migration repairs what is already at rest so
// the normaliser never has to fire.
//
// Idempotency: the filter matches only malformed values, so a second run
// matches nothing and reports 0.
// ---------------------------------------------------------------------------

// Explicit on the schema — NOT Mongoose's pluralised default.
export const WASHER_PROFILES_COLLECTION = 'washer_profiles';

export interface WasherMapLocationRepairResult {
  /** Profiles whose mapLocation was (or would be) cleared. */
  matched: number;
  updated: number;
  /** Every affected profile, logged so the change is auditable. */
  affected: { id: string; uid: string; mapLocation: unknown }[];
}

export interface WasherMapLocationRepairOptions {
  connection: Connection;
  /** false ⇒ dry run: count and list, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

/**
 * Matches a mapLocation that exists but cannot satisfy `MapLocation`.
 * `$not: { $type: 'number' }` also catches a missing key, which is what an
 * empty `{}` sub-document looks like in storage.
 */
const MALFORMED_FILTER = {
  mapLocation: { $ne: null, $exists: true },
  $or: [
    { 'mapLocation.latitude': { $not: { $type: 'number' } } },
    { 'mapLocation.longitude': { $not: { $type: 'number' } } },
    { 'mapLocation.latitude': Number.NaN },
    { 'mapLocation.longitude': Number.NaN },
  ],
};

export async function repairWasherMapLocation(
  options: WasherMapLocationRepairOptions,
): Promise<WasherMapLocationRepairResult> {
  const { connection, apply, log = () => undefined } = options;
  const profiles = connection.collection(WASHER_PROFILES_COLLECTION);

  const docs = await profiles
    .find(MALFORMED_FILTER, { projection: { _id: 1, uid: 1, mapLocation: 1 } })
    .toArray();

  const result: WasherMapLocationRepairResult = {
    matched: docs.length,
    updated: 0,
    affected: docs.map((d) => ({
      id: String(d._id),
      uid: String(d.uid ?? ''),
      mapLocation: d.mapLocation,
    })),
  };

  for (const doc of result.affected) {
    log(
      `washer_profile ${doc.id} (uid ${doc.uid}): malformed mapLocation ${JSON.stringify(doc.mapLocation)}`,
    );
  }

  if (!apply || docs.length === 0) return result;

  // Cleared to null rather than $unset: null is the schema's own default for
  // "no pin", and the field is read with `!loc` checks either way.
  const res = await profiles.updateMany(MALFORMED_FILTER, {
    $set: { mapLocation: null },
  });
  result.updated = res.modifiedCount;

  return result;
}
