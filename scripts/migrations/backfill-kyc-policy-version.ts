// Backfill `verificationPolicyVersion` on providers verified before the field
// existed.
//
// Until now, "was this provider verified under the older required-document
// set?" could only be INFERRED — usually from the document count — which makes
// a legitimately grandfathered merchant read as "0 of 6 — Incomplete" in the
// admin panel. This stamps the fact once so nothing has to guess again.
//
// Rule, per APPROVED provider:
//   - satisfies the CURRENT required set  -> KYC_POLICY_VERSION  (verified under today's rules)
//   - does not                            -> LEGACY_KYC_POLICY_VERSION (grandfathered)
// Providers that are not APPROVED are left null: they are in progress, not legacy.
//
// Idempotent — only touches documents whose verificationPolicyVersion is null.
//
// Usage:
//   npx ts-node scripts/migrations/backfill-kyc-policy-version.ts [--apply]
// Without --apply it reports what it WOULD change and writes nothing.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const KYC_POLICY_VERSION = 2;
const LEGACY_KYC_POLICY_VERSION = 1;

const REQUIRED: Record<string, string[]> = {
  MERCHANT_BRANCH: [
    'OWNER_VALID_ID',
    'DTI_CERTIFICATE',
    'BIR_2303',
    'BUSINESS_PHOTO_STOREFRONT',
    'BUSINESS_PHOTO_INTERIOR',
    'BUSINESS_PHOTO_MACHINES',
  ],
  WASHER: [
    'VALID_ID',
    'VALID_ID_BACK',
    'SELFIE',
    'PROOF_OF_ADDRESS',
    'BARANGAY_CLEARANCE',
  ],
};

function resolveMongoUri(): { uri: string; mode: string } {
  const online =
    (process.env.MONGODB_ONLINE ?? '').trim().toLowerCase() === 'on';
  const key = online ? 'MONGODB_URI_ONLINE' : 'MONGODB_URI_LOCAL';
  const uri = process.env[key];
  if (!uri) throw new Error(`${key} is not set in .env`);
  return { uri, mode: online ? 'online (Atlas)' : 'local' };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { uri, mode } = resolveMongoUri();
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Mongo: ${mode}`);
  console.log(
    apply
      ? 'Mode:  APPLY (writing)'
      : 'Mode:  DRY RUN (use --apply to write)\n',
  );

  const docs = db.collection('kyc_documents');
  const targets: Array<{
    collection: string;
    providerType: string;
    idField: '_id';
  }> = [
    { collection: 'branches', providerType: 'MERCHANT_BRANCH', idField: '_id' },
    { collection: 'washer_profiles', providerType: 'WASHER', idField: '_id' },
  ];

  let current = 0;
  let legacy = 0;

  for (const t of targets) {
    const coll = db.collection(t.collection);
    const providers = await coll
      .find({
        verificationStatus: 'APPROVED',
        verificationPolicyVersion: { $in: [null, undefined] },
      })
      .toArray();

    for (const p of providers) {
      const approved = await docs
        .find({
          providerId: String(p._id),
          status: 'APPROVED',
          documentType: { $in: REQUIRED[t.providerType] },
        })
        .toArray();

      const satisfied = new Set(approved.map((d) => d.documentType as string));
      const meetsCurrent = REQUIRED[t.providerType].every((type) =>
        satisfied.has(type),
      );
      const version = meetsCurrent
        ? KYC_POLICY_VERSION
        : LEGACY_KYC_POLICY_VERSION;

      if (meetsCurrent) current += 1;
      else legacy += 1;

      const name = (p.branchName ?? p.displayName ?? '(unnamed)') as string;
      console.log(
        `  ${t.providerType.padEnd(16)} ${name.slice(0, 34).padEnd(34)} ` +
          `${satisfied.size}/${REQUIRED[t.providerType].length} approved -> v${version}` +
          `${meetsCurrent ? '' : '  [grandfathered]'}`,
      );

      if (apply) {
        await coll.updateOne(
          { _id: p._id },
          { $set: { verificationPolicyVersion: version } },
        );
      }
    }
  }

  console.log(
    `\n${current + legacy} approved provider(s): ${current} on the current policy, ` +
      `${legacy} grandfathered.`,
  );
  if (!apply) console.log('Nothing written. Re-run with --apply to persist.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
