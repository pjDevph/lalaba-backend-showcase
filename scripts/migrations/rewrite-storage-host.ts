// Migration: repoint stored storage URLs at a new emulator host.
//
// Storage URLs are persisted absolute, host included, and under the Storage
// emulator that host is whatever FIREBASE_STORAGE_EMULATOR_HOST said at upload
// time. `localhost:9199` resolves differently per client — fine from the iOS
// simulator, connection-refused from an Android emulator (where the host is
// 10.0.2.2) and from any physical device. The fix is to point the env var at
// the machine's LAN IP; this repairs the rows written before that.
//
// Usage:
//   npx ts-node scripts/migrations/rewrite-storage-host.ts --from localhost:9199 --to 192.168.1.5:9199
//   npx ts-node scripts/migrations/rewrite-storage-host.ts --from localhost:9199 --to 192.168.1.5:9199 --apply
//
// --to defaults to FIREBASE_STORAGE_EMULATOR_HOST, so after updating .env the
// usual invocation is just `--from localhost:9199`.
//
// Requires MONGODB_URI. Safe to re-run: the filter only matches the old host,
// so the second run reports 0. Run it again with --from/--to swapped to undo.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { rewriteStorageHost } from '../../src/migrations/storage-host-rewrite.migration';

dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const fromHost = arg('from');
  const toHost = arg('to') ?? process.env.FIREBASE_STORAGE_EMULATOR_HOST;

  if (!fromHost) throw new Error('--from <host:port> is required');
  if (!toHost) {
    throw new Error(
      '--to <host:port> is required (or set FIREBASE_STORAGE_EMULATOR_HOST)',
    );
  }

  // app.module.ts picks MONGODB_URI_ONLINE or MONGODB_URI_LOCAL off
  // MONGODB_ONLINE; .env defines those two and no bare MONGODB_URI. Resolving
  // the same way means this script targets whichever database the app is
  // currently pointed at, instead of failing on an env var that does not
  // exist. MONGODB_URI still wins if it is set, for one-off targets.
  const isOnline =
    (process.env.MONGODB_ONLINE ?? 'off').trim().toLowerCase() === 'on';
  const uri =
    process.env.MONGODB_URI ??
    (isOnline ? process.env.MONGODB_URI_ONLINE : process.env.MONGODB_URI_LOCAL);
  if (!uri) {
    throw new Error(
      `No connection string: set MONGODB_URI, or ${isOnline ? 'MONGODB_URI_ONLINE' : 'MONGODB_URI_LOCAL'} (MONGODB_ONLINE=${isOnline ? 'on' : 'off'}).`,
    );
  }
  console.log(`Target: ${isOnline ? 'ONLINE (Atlas)' : 'LOCAL'} database`);

  await mongoose.connect(uri);

  const result = await rewriteStorageHost({
    connection: mongoose.connection,
    fromHost,
    toHost,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    apply
      ? `Applied: ${result.updated} document(s) repointed from ${fromHost} to ${toHost}.`
      : `Dry run: ${result.matched} document(s) carry URLs on ${fromHost}. Re-run with --apply to rewrite them to ${toHost}.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
