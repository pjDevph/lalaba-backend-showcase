// B6 / DB-008 — build the hot-path indexes.
//
// Five collections had no index beyond _id, each on a read path a user waits
// on. This is a migration rather than schema-declared + autoIndex because
// production index creation should be a deliberate, observable step with a
// person watching it, not something a Render deploy does on the way up.
//
// Usage:
//   npx ts-node scripts/migrations/create-hot-path-indexes.ts          # plan
//   npx ts-node scripts/migrations/create-hot-path-indexes.ts --apply  # build
//
// Requires MONGODB_URI. Safe to re-run: it inspects listIndexes() first and
// creates only what is missing. It NEVER drops or rebuilds an existing index,
// so a run cannot take a query plan away from a live system.
//
// Run it BEFORE the deploy that turns autoIndex off in production, so there is
// no window where neither mechanism is building indexes.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  createHotPathIndexes,
  HOT_PATH_INDEXES,
} from '../../src/migrations/hot-path-indexes.migration';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  if (!apply) {
    console.log('Dry run — nothing will be created.\n');
    console.log('Planned indexes:');
    for (const ix of HOT_PATH_INDEXES) {
      console.log(
        `  ${ix.collection}.${ix.name}  ${JSON.stringify(ix.key)}\n      ${ix.reason}`,
      );
    }
    console.log('\nRe-run with --apply to create the missing ones.');
    return;
  }

  await mongoose.connect(uri);
  const result = await createHotPathIndexes(mongoose.connection, (m) =>
    console.log(m),
  );

  if (result.conflicts > 0) {
    console.error(
      `\n${result.conflicts} index name(s) already exist with a different key and were left untouched.\n` +
        "Resolve those by hand — dropping an index someone else created is not this script's call.",
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(
    `\nDone: ${result.created} created, ${result.skipped} already present.`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
