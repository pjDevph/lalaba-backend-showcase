// Migration: backfill WasherProfile.storeName.
//
// A washer's shop is listed under `storeName`, and the read layer no longer
// falls back to her personal `displayName`. Washers who registered before the
// field existed have none, so without this they list as the generic "Home
// Laundry". The name comes from their anchor Branch's `branchName` ("<First>'s
// Laundry", generated at registration), with recomputed fallbacks behind it.
// See src/migrations/washer-store-name-backfill.migration.ts.
//
// Usage:
//   npx ts-node scripts/migrations/backfill-washer-store-name.ts          # dry run
//   npx ts-node scripts/migrations/backfill-washer-store-name.ts --apply  # write
//
// Requires MONGODB_URI. Safe to re-run: the filter only matches profiles with no
// usable storeName, so the second run reports 0.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { backfillWasherStoreName } from '../../src/migrations/washer-store-name-backfill.migration';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  await mongoose.connect(uri);

  const result = await backfillWasherStoreName({
    connection: mongoose.connection,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    apply
      ? `Applied: storeName written on ${result.updated} washer profile(s).`
      : `Dry run: ${result.matched} washer profile(s) have no store name. Re-run with --apply to write them.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
