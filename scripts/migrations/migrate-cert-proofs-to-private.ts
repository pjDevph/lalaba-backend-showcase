// Migration: move washer certification evidence out of the PUBLIC media
// bucket into the private evidence store (RISK-P0-002 residue).
//
// Usage:
//   npx ts-node scripts/migrations/migrate-cert-proofs-to-private.ts          # dry run
//   npx ts-node scripts/migrations/migrate-cert-proofs-to-private.ts --apply  # write
//
// Requires MONGODB_URI plus the same storage env the API uses (FIREBASE_*, and
// FIREBASE_STORAGE_EMULATOR_HOST when running against local). Safe to re-run: a
// completed profile has no public URLs left, so the second run reports 0.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { migrateCertProofsToPrivate } from '../../src/migrations/cert-proofs-to-private.migration';
import { buildStorageProvider } from './storage-provider.bootstrap';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  const storage = await buildStorageProvider();
  await mongoose.connect(uri);

  const result = await migrateCertProofsToPrivate({
    connection: mongoose.connection,
    storage,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    apply
      ? `Applied: ${result.objectsCopied} object(s) copied to private storage across ${result.profilesMigrated}/${result.profilesScanned} profile(s); ${result.objectsFailed} failure(s) left for a re-run.`
      : `Dry run: ${result.profilesScanned} washer profile(s) still hold public certification URLs. Re-run with --apply to copy and retire them.`,
  );
  if (result.washerUids.length > 0) {
    console.log(`Washer uids: ${result.washerUids.join(', ')}`);
  }

  await mongoose.disconnect();
  if (result.objectsFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
