import type { Connection } from 'mongoose';

// ---------------------------------------------------------------------------
// Storage URLs are persisted ABSOLUTE, host included. Under the Firebase
// Storage emulator that host comes from FIREBASE_STORAGE_EMULATOR_HOST
// (firebase-storage.provider.ts publicUrlFor), so whatever that env var said
// at upload time is baked into the database forever.
//
// When it said `localhost:9199`, the resulting rows were readable from some
// clients and dead on others, because `localhost` is resolved by the CLIENT:
//
//   iOS simulator    — shares the host's network stack, so localhost is the Mac ✓
//   Android emulator — localhost is the emulator's OWN loopback; the host is
//                      10.0.2.2, so every such URL is connection-refused      ✗
//   physical device  — localhost is the phone itself                          ✗
//
// The symptom is a washer whose photo shows in the customer app and not in her
// own. Pointing the env var at the machine's LAN IP fixes new uploads; this
// migration repairs what is already at rest.
//
// Idempotency: the filter matches only the old host, so a second run matches
// nothing and reports 0. Re-running with the hosts swapped reverses it.
// ---------------------------------------------------------------------------

/** Collection → fields that hold an absolute storage URL. */
export const STORAGE_URL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Explicit on the schema — NOT Mongoose's pluralised default.
  washer_profiles: ['photoUrl', 'logoUrl', 'coverPhotoUrl', 'featuredPhotos'],
  users: ['photoUrl'],
};

// activity_logs.metadata also contains these URLs and is deliberately NOT in
// the map above. It is an audit trail: it records the URL that was actually
// issued at the time, and rewriting history to match present-day config would
// make the log lie about what happened.

export interface StorageHostRewriteResult {
  /** Documents carrying at least one URL on the old host. */
  matched: number;
  updated: number;
  /** Per-collection detail, logged so the change is auditable. */
  affected: { collection: string; id: string; field: string; from: string }[];
}

export interface StorageHostRewriteOptions {
  connection: Connection;
  /** e.g. 'localhost:9199' — host:port only, no scheme. */
  fromHost: string;
  /** e.g. '10.250.1.125:9199' — host:port only, no scheme. */
  toHost: string;
  /** false ⇒ dry run: count and list, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Swaps the host of every stored storage URL. Only the host segment is
 * touched: the object key, its percent-encoding and the ?alt=media query all
 * survive untouched, so a rewritten URL differs from the original in exactly
 * the part that was wrong.
 */
export async function rewriteStorageHost(
  options: StorageHostRewriteOptions,
): Promise<StorageHostRewriteResult> {
  const {
    connection,
    fromHost,
    toHost,
    apply,
    log = () => undefined,
  } = options;

  if (!fromHost || !toHost) {
    throw new Error('rewriteStorageHost requires both fromHost and toHost.');
  }
  if (fromHost === toHost) {
    throw new Error(
      `fromHost and toHost are both "${fromHost}" — nothing to rewrite.`,
    );
  }
  if (/^https?:\/\//.test(fromHost) || /^https?:\/\//.test(toHost)) {
    throw new Error('Pass host:port only, without the scheme.');
  }

  const needle = `http://${fromHost}/`;
  const replacement = `http://${toHost}/`;
  const matcher = new RegExp(escapeRegex(needle));

  const result: StorageHostRewriteResult = {
    matched: 0,
    updated: 0,
    affected: [],
  };

  for (const [collectionName, fields] of Object.entries(STORAGE_URL_FIELDS)) {
    const collection = connection.collection(collectionName);
    const docs = await collection
      .find(
        { $or: fields.map((f) => ({ [f]: matcher })) },
        { projection: fields.reduce((p, f) => ({ ...p, [f]: 1 }), { _id: 1 }) },
      )
      .toArray();

    for (const doc of docs) {
      const patch: Record<string, string | string[]> = {};

      for (const field of fields) {
        const current = doc[field] as unknown;

        // Arrays (featuredPhotos) and plain strings are both in scope; every
        // other shape — null, undefined, a stray object — is left alone.
        if (typeof current === 'string' && current.includes(needle)) {
          patch[field] = current.replace(needle, replacement);
          result.affected.push({
            collection: collectionName,
            id: String(doc._id),
            field,
            from: current,
          });
        } else if (Array.isArray(current)) {
          const next = current.map((entry) =>
            typeof entry === 'string' && entry.includes(needle)
              ? entry.replace(needle, replacement)
              : (entry as string),
          );
          if (next.some((entry, i) => entry !== current[i])) {
            patch[field] = next;
            result.affected.push({
              collection: collectionName,
              id: String(doc._id),
              field,
              from: `${current.length} entr${current.length === 1 ? 'y' : 'ies'}`,
            });
          }
        }
      }

      if (Object.keys(patch).length === 0) continue;
      result.matched += 1;
      log(
        `${collectionName} ${String(doc._id)}: rewriting ${Object.keys(patch).join(', ')}`,
      );

      if (apply) {
        const res = await collection.updateOne(
          { _id: doc._id },
          { $set: patch },
        );
        result.updated += res.modifiedCount;
      }
    }
  }

  return result;
}
