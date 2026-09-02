/**
 * Jest globalSetup for the e2e suite.
 *
 * Boots ONE in-memory MongoDB replica set for the whole e2e run. A replica set
 * (not a standalone) is mandatory: WalletsService.postVerifiedTopUp runs the
 * top-up credit inside a `session.withTransaction`, and transactions require a
 * replica set. Same pattern as src/wallets/wallets.service.spec.ts.
 *
 * The base URI is exported through process.env so each test file (see
 * test/setup-e2e.ts) can carve out its own database name and stay isolated.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

declare global {
  var __E2E_REPLSET__: MongoMemoryReplSet | undefined;
}

export default async function globalSetup(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  globalThis.__E2E_REPLSET__ = replSet;
  // e.g. mongodb://127.0.0.1:PORT/?replicaSet=testset
  process.env.E2E_MONGO_BASE_URI = replSet.getUri();
}
