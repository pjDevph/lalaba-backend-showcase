import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const replSet = (globalThis as { __E2E_REPLSET__?: MongoMemoryReplSet })
    .__E2E_REPLSET__;
  if (replSet) await replSet.stop();
}
