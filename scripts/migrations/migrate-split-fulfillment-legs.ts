// Migration: split the single provider-performed fulfillment toggle into its
// two independent legs, so "rider collects / customer collects back" and
// "customer drops off / rider delivers" become expressible.
//
//   weekly.<day>.fulfillment.pickupAndDelivery → providerPickup + providerDelivery
//
// Both legs inherit the legacy value, so nothing a provider currently offers is
// turned off. `booking_date_overrides.fulfillment` is covered in the same pass.
//
// Usage:
//   npx ts-node scripts/migrations/migrate-split-fulfillment-legs.ts          # dry run
//   npx ts-node scripts/migrations/migrate-split-fulfillment-legs.ts --apply  # write
//
// Reads MONGODB_ONLINE to pick MONGODB_URI_LOCAL vs MONGODB_URI_ONLINE. Safe to
// re-run: the filter only matches documents that still carry the legacy field,
// so the second run reports 0.
//
// NOT required for correctness — `dayFulfillmentOf()` applies the same fallback
// at read time. Running it lets that shim be retired later.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { migrateSplitFulfillmentLegs } from '../../src/migrations/split-fulfillment-legs.migration';

dotenv.config();

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
  console.log(`Mongo: ${mode}`);

  const result = await migrateSplitFulfillmentLegs({
    connection: mongoose.connection,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    apply
      ? `Applied: ${result.configsUpdated} availability config(s) and ${result.overridesUpdated} date override(s) rewritten.`
      : `Dry run: ${result.configsMatched} availability config(s) and ${result.overridesMatched} date override(s) still carry the legacy field. Re-run with --apply to rewrite.`,
  );
  console.log(
    `Affected ids (${result.affectedIds.length}): ${result.affectedIds.join(', ') || '(none)'}`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
