import { randomUUID } from 'crypto';
import type { Connection } from 'mongoose';
import type { StorageProvider } from '../storage/storage-provider.interface';

// ---------------------------------------------------------------------------
// RISK-P0-002 residue: washer certification evidence used to be uploaded to
// the PUBLIC media bucket and stored as anonymous-readable URLs on
// WasherProfile.certProofUrls. This migration copies each object into the
// private evidence store and retires the public URL.
//
// Idempotency contract: the unit of work is a single URL, not a profile. Each
// URL is copied, then moved out of `certProofUrls` into `legacyCertProofUrls`
// with its new key appended to `certProofObjectKeys` — in one update. A crash
// mid-profile therefore leaves the remaining URLs (and only those) for the
// next run, and a completed profile is never revisited because `certProofUrls`
// is empty. A second full run reports 0 profiles and 0 objects.
// ---------------------------------------------------------------------------

export interface FetchedObject {
  buffer: Buffer;
  contentType: string;
}

export type ObjectFetcher = (url: string) => Promise<FetchedObject>;

export interface CertProofMigrationResult {
  /** Profiles that still had at least one public URL when the run started. */
  profilesScanned: number;
  /** Profiles whose public URLs were fully retired by this run. */
  profilesMigrated: number;
  /** Objects copied into the private store (0 in dry-run). */
  objectsCopied: number;
  /** Objects that could not be fetched/copied — left in place for a re-run. */
  objectsFailed: number;
  /** Every washer uid touched (or that would be touched, in dry-run). */
  washerUids: string[];
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
};

/** Prefers the URL's own extension; falls back to the served content type. */
export function deriveExtension(url: string, contentType: string): string {
  const fromUrl = url.split('?')[0].split('#')[0].split('.').pop();
  if (fromUrl && /^[a-zA-Z0-9]{1,5}$/.test(fromUrl))
    return fromUrl.toLowerCase();
  return EXTENSION_BY_CONTENT_TYPE[contentType] ?? 'bin';
}

/** Default fetcher — plain HTTP GET of the public object URL. */
export const httpObjectFetcher: ObjectFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
};

export interface CertProofMigrationOptions {
  connection: Connection;
  storage: StorageProvider;
  /** false ⇒ dry run: report only, write nothing and copy nothing. */
  apply: boolean;
  fetchObject?: ObjectFetcher;
  log?: (message: string) => void;
}

export async function migrateCertProofsToPrivate(
  options: CertProofMigrationOptions,
): Promise<CertProofMigrationResult> {
  const {
    connection,
    storage,
    apply,
    fetchObject = httpObjectFetcher,
    log = () => undefined,
  } = options;

  const profiles = connection.collection('washer_profiles');
  const result: CertProofMigrationResult = {
    profilesScanned: 0,
    profilesMigrated: 0,
    objectsCopied: 0,
    objectsFailed: 0,
    washerUids: [],
  };

  const cursor = profiles.find({
    certProofUrls: { $exists: true, $ne: null, $not: { $size: 0 } },
  });

  while (await cursor.hasNext()) {
    const profile = await cursor.next();
    if (!profile) continue;
    const urls: string[] = (profile.certProofUrls ?? []).filter(
      (u: unknown): u is string => typeof u === 'string' && u.length > 0,
    );
    if (urls.length === 0) continue;

    result.profilesScanned++;
    result.washerUids.push(String(profile.uid));
    log(
      `washer ${profile.uid} (profile ${String(profile._id)}): ${urls.length} public certification object(s)`,
    );

    if (!apply) continue;

    let failedForProfile = 0;
    for (const url of urls) {
      try {
        const { buffer, contentType } = await fetchObject(url);
        const ext = deriveExtension(url, contentType);
        const key = `cert-proofs/washer/${String(profile._id)}/${randomUUID()}.${ext}`;
        const objectKey = await storage.uploadPrivate(buffer, key, contentType);

        // One atomic step per URL — the public URL only leaves certProofUrls
        // once its private copy exists, so a re-run resumes exactly here.
        await profiles.updateOne(
          { _id: profile._id },
          // Raw-driver typings model $pull/$push against AnyObject, which
          // cannot express "pull this string from this string[]" — the shape
          // is correct, the generic is not.
          {
            $pull: { certProofUrls: url },
            $push: {
              certProofObjectKeys: objectKey,
              legacyCertProofUrls: url,
            },
          } as unknown as Record<string, unknown>,
        );
        result.objectsCopied++;
      } catch (err) {
        failedForProfile++;
        result.objectsFailed++;
        log(
          `  ! failed to copy ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (failedForProfile === 0) result.profilesMigrated++;
  }

  return result;
}
