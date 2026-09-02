// DEV ONLY — mark a courier's liveness selfie ACTIVE without taking one.
//
// The Android emulator's camera renders a synthetic test pattern, so the
// liveness check can never see a face and a courier can never get past
// /courier-selfie. That blocks the entire courier leg of any local E2E run.
//
// This writes ONLY to the local database. It ships no code into the app and
// changes no gate: GqlAuthGuard still requires selfieStatus === 'ACTIVE', and
// still rejects couriers who do not have it. All this does is set the field a
// real selfie would have set, on a machine that cannot photograph one.
//
// It REFUSES to run against anything but localhost. That is the safety
// property that matters — a bypass is only acceptable while it is impossible
// to point at real users.
//
// Usage:
//   npx ts-node scripts/dev/activate-courier-selfie.ts courier@example.com
//   npx ts-node scripts/dev/activate-courier-selfie.ts --all
//   npx ts-node scripts/dev/activate-courier-selfie.ts --revoke courier@example.com

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// Exact hostnames, matched exactly. A substring check is not good enough here:
// 'mongo' is a substring of 'mongodb.net', so an Atlas URI sailed through the
// first version of this guard — the precise thing it exists to stop.
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'mongo',
  'lalaba-mongo',
  'host.docker.internal',
]);

function assertLocal(uri: string): void {
  // Strip scheme, then any user:pass@ prefix, then the path/query.
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const authority = afterScheme.split(/[/?]/)[0];
  const hostPort = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;

  // A replica set may list several hosts — EVERY one must be local.
  const hosts = hostPort
    .split(',')
    .map((h) => h.split(':')[0].trim().toLowerCase())
    .filter(Boolean);

  const isLocal = hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(h));
  if (!isLocal) {
    throw new Error(
      `Refusing to run: ${hosts.join(', ')} is not a local database.\n` +
        'This script exists only to work around the emulator camera. ' +
        'A courier on a real deployment must take a real selfie.',
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const all = args.includes('--all');
  const email = args.find((a) => !a.startsWith('--'));

  if (!all && !email) {
    throw new Error('Pass a courier email, or --all for every courier.');
  }

  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGODB_URI_LOCAL ||
    'mongodb://localhost:27017/lalabaDev?replicaSet=rs0';
  assertLocal(uri);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle');

  const courierRole = await db
    .collection('roles')
    .findOne({ roleId: 'courier' });
  if (!courierRole)
    throw new Error('No courier role seeded — start the backend once first.');

  const filter: Record<string, unknown> = { role: courierRole._id };
  if (!all) filter.email = email;

  const status = revoke ? 'REVOKED' : 'ACTIVE';
  const result = await db.collection('users').updateMany(filter, {
    $set: {
      selfieStatus: status,
      selfieVerifiedAt: revoke ? null : new Date(),
    },
  });

  const couriers = await db
    .collection('users')
    .find(filter)
    .project({ email: 1, selfieStatus: 1 })
    .toArray();

  console.log(`\n${result.modifiedCount} courier(s) set to ${status}:`);
  for (const c of couriers) console.log(`  ${c.email} → ${c.selfieStatus}`);
  console.log(
    '\nSign out and back in on the device — the guard reads a cached user\n' +
      'document, so an existing session keeps the old value for up to 5 minutes.\n',
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
