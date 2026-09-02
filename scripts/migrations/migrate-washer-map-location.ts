// Migration: clear malformed WasherProfile.mapLocation values.
//
// MapLocation declares latitude/longitude as Float!, so a stored pin missing
// either coordinate makes the whole profile unreadable through GraphQL:
// "Cannot return null for non-nullable field MapLocation.latitude." This
// rewrites those to null ("no pin set"), which is what the schema defaults to.
//
// Usage:
//   npx ts-node scripts/migrations/migrate-washer-map-location.ts          # dry run
//   npx ts-node scripts/migrations/migrate-washer-map-location.ts --apply  # write
//
// Requires MONGODB_URI. Safe to re-run: the filter only matches malformed
// values, so the second run reports 0.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { repairWasherMapLocation } from '../../src/migrations/washer-map-location-repair.migration';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  await mongoose.connect(uri);

  const result = await repairWasherMapLocation({
    connection: mongoose.connection,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    apply
      ? `Applied: mapLocation cleared on ${result.updated} washer profile(s).`
      : `Dry run: ${result.matched} washer profile(s) carry a malformed mapLocation. Re-run with --apply to clear them.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
