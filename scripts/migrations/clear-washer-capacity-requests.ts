// Migration: clear per-washer booking capacity requests.
//
// Capacity is no longer provider-writable — one platform number governs every
// washer. Values written under the old provider-editable control are still
// honoured by the engine's min(requested, entitled), so a washer who once set
// "1 per day" would stay pinned at 1 with no UI left to raise it. See
// src/migrations/clear-washer-capacity-requests.migration.ts.
//
// Usage:
//   npx ts-node scripts/migrations/clear-washer-capacity-requests.ts          # dry run
//   npx ts-node scripts/migrations/clear-washer-capacity-requests.ts --apply  # write
//
// Requires MONGODB_URI. Safe to re-run: the filter only matches configs that
// still carry a value, so the second run reports 0.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { clearWasherCapacityRequests } from '../../src/migrations/clear-washer-capacity-requests.migration';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  await mongoose.connect(uri);

  const result = await clearWasherCapacityRequests({
    connection: mongoose.connection,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    apply
      ? `Applied: capacity cleared on ${result.updated} washer booking config(s).`
      : `Dry run: ${result.matched} washer booking config(s) carry a capacity request. Re-run with --apply to clear them.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
