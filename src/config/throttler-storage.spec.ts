import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { RedisMemoryServer } from 'redis-memory-server';
import {
  createThrottlerStorage,
  resolveThrottlerStorage,
  ThrottlerStorageConfigError,
} from './throttler-storage';

/**
 * SEC-004 / B2 — TEST-REDIS-001..008.
 *
 * TEST-REDIS-006 is the actual closure test. The defect was never "we don't
 * use Redis"; it was that two replicas kept independent counters. So that case
 * builds TWO storage services with TWO separate connections to ONE Redis and
 * asserts they consume the same bucket — the shape of two Render instances
 * behind one Key Value service.
 *
 * These run against a REAL redis-server (redis-memory-server, the same pattern
 * as mongodb-memory-server elsewhere in this repo), not a mock. That is not
 * fastidiousness: ThrottlerStorageRedisService does its counting in a Lua
 * script via EVAL, and it type-checks its argument with `instanceof Redis`, so
 * a mock client is silently replaced by a real one that dials localhost. A
 * mocked version of this suite passes while testing nothing.
 */

// ---------------------------------------------------------------------------
// Decision (pure — no connection opened)
// ---------------------------------------------------------------------------

describe('TEST-REDIS-001 — dev/test without REDIS_URL', () => {
  it('HP: development falls back to in-memory', () => {
    const d = resolveThrottlerStorage({ NODE_ENV: 'development' });
    expect(d.kind).toBe('memory');
  });

  it('HP: test falls back to in-memory', () => {
    expect(resolveThrottlerStorage({ NODE_ENV: 'test' }).kind).toBe('memory');
  });

  it('HP: an unset NODE_ENV is treated as non-production', () => {
    expect(resolveThrottlerStorage({}).kind).toBe('memory');
  });

  it('HP: the memory path yields undefined so Nest uses its own default', () => {
    const storage = createThrottlerStorage(
      resolveThrottlerStorage({ NODE_ENV: 'development' }),
    );
    expect(storage).toBeUndefined();
  });
});

describe('TEST-REDIS-002 — production without REDIS_URL refuses to start', () => {
  it('EC: throws rather than silently using memory', () => {
    expect(() => resolveThrottlerStorage({ NODE_ENV: 'production' })).toThrow(
      ThrottlerStorageConfigError,
    );
  });

  it('EC: the message names the variable', () => {
    expect(() => resolveThrottlerStorage({ NODE_ENV: 'production' })).toThrow(
      /REDIS_URL is required in production/,
    );
  });

  it('EC: an empty or whitespace REDIS_URL counts as missing', () => {
    // The failure this closes: a Render env var created but left blank would
    // otherwise read as "set" and quietly select the memory path.
    for (const REDIS_URL of ['', '   ']) {
      expect(() =>
        resolveThrottlerStorage({ NODE_ENV: 'production', REDIS_URL }),
      ).toThrow(ThrottlerStorageConfigError);
    }
  });

  it('EC: there is NO env flag that permits a production memory fallback', () => {
    // Guards against someone later adding an escape hatch under pressure.
    const attempts = [
      { NODE_ENV: 'production', ALLOW_MEMORY_THROTTLER: 'true' },
      { NODE_ENV: 'production', THROTTLER_STORAGE: 'memory' },
      { NODE_ENV: 'production', SKIP_REDIS: '1' },
    ];
    for (const env of attempts) {
      expect(() => resolveThrottlerStorage(env)).toThrow(
        ThrottlerStorageConfigError,
      );
    }
  });
});

describe('TEST-REDIS-003 — REDIS_URL selects Redis storage', () => {
  it('HP: production with a URL resolves to redis', () => {
    const d = resolveThrottlerStorage({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://red-abc:6379',
    });
    expect(d.kind).toBe('redis');
    expect(d.redisUrl).toBe('redis://red-abc:6379');
  });

  it('HP: development with a URL also uses redis (parity with prod)', () => {
    // So a developer can reproduce production limiting behaviour locally.
    const d = resolveThrottlerStorage({
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(d.kind).toBe('redis');
  });

  it('HP: surrounding whitespace is trimmed, not treated as a distinct host', () => {
    const d = resolveThrottlerStorage({
      NODE_ENV: 'production',
      REDIS_URL: '  redis://red-abc:6379  ',
    });
    expect(d.redisUrl).toBe('redis://red-abc:6379');
  });
});

// ---------------------------------------------------------------------------
// Behaviour against a Redis-compatible backing store
// ---------------------------------------------------------------------------

describe('Redis-backed counting', () => {
  const THROTTLER = 'default';
  const TTL_MS = 60_000;
  const LIMIT = 5;
  const BLOCK_MS = 60_000;

  let server: RedisMemoryServer;
  let host: string;
  let port: number;
  const clients: Redis[] = [];

  beforeAll(async () => {
    server = new RedisMemoryServer();
    host = await server.getHost();
    port = await server.getPort();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
    await server.stop();
  });

  beforeEach(async () => {
    const flusher = new Redis(port, host);
    await flusher.flushall();
    await flusher.quit();
  });

  /** One "app instance": its own connection, its own storage service. */
  const newInstance = () => {
    const client = new Redis(port, host, { maxRetriesPerRequest: null });
    clients.push(client);
    return new ThrottlerStorageRedisService(client);
  };

  const hit = (storage: ThrottlerStorageRedisService, key: string) =>
    storage.increment(key, TTL_MS, LIMIT, BLOCK_MS, THROTTLER);

  it('TEST-REDIS-004 — a request increments the Redis-backed bucket', async () => {
    const storage = newInstance();

    expect((await hit(storage, 'uid:alice')).totalHits).toBe(1);
    expect((await hit(storage, 'uid:alice')).totalHits).toBe(2);
  });

  it('TEST-REDIS-005 — the bucket carries a TTL and resets when it expires', async () => {
    const storage = newInstance();
    const client = new Redis(port, host);
    clients.push(client);

    await hit(storage, 'uid:alice');
    const second = await hit(storage, 'uid:alice');
    expect(second.totalHits).toBe(2);
    // Without a TTL the key would live forever and a user who hit the limit
    // once could never recover.
    expect(second.timeToExpire).toBeGreaterThan(0);
    expect(second.timeToExpire).toBeLessThanOrEqual(TTL_MS / 1000);

    const keys = await client.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(await client.pttl(k)).toBeGreaterThan(0);

    // Expire the window for real.
    await client.flushall();
    expect((await hit(storage, 'uid:alice')).totalHits).toBe(1);
  });

  it('TEST-REDIS-006 — two app instances share ONE bucket (B2 closure)', async () => {
    // The defect itself: two replicas each counted to the limit independently,
    // so the effective budget was limit x replicas. Two connections, two
    // storage services, one Redis — the shape of two Render instances behind
    // one Key Value service.
    const instanceA = newInstance();
    const instanceB = newInstance();

    const a1 = await hit(instanceA, 'uid:alice');
    const b1 = await hit(instanceB, 'uid:alice');
    const a2 = await hit(instanceA, 'uid:alice');

    expect(a1.totalHits).toBe(1);
    // The assertion that fails against in-memory storage: instance B sees
    // instance A's request. With per-process counters this would be 1.
    expect(b1.totalHits).toBe(2);
    expect(a2.totalHits).toBe(3);
  });

  it('TEST-REDIS-006b — the shared budget is consumed once, not once per instance', async () => {
    const instances = [newInstance(), newInstance(), newInstance()];

    let last = 0;
    for (let i = 0; i < LIMIT; i++) {
      last = (await hit(instances[i % instances.length], 'uid:alice'))
        .totalHits;
    }
    expect(last).toBe(LIMIT);

    // One more crosses the limit, whichever instance serves it.
    const over = await hit(instances[1], 'uid:alice');
    expect(over.totalHits).toBeGreaterThan(LIMIT);
    expect(over.isBlocked).toBe(true);
  });

  it('TEST-REDIS-006c — a block set by one instance is seen by the others', async () => {
    // Not just the counter: the block flag has to be shared too, or a limited
    // caller simply retries until the load balancer picks a different replica.
    const instanceA = newInstance();
    const instanceB = newInstance();

    for (let i = 0; i <= LIMIT; i++) await hit(instanceA, 'uid:alice');

    const onB = await hit(instanceB, 'uid:alice');
    expect(onB.isBlocked).toBe(true);
    expect(onB.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('TEST-REDIS-007 — two uids get independent buckets', async () => {
    const instanceA = newInstance();
    const instanceB = newInstance();

    await hit(instanceA, 'uid:alice');
    await hit(instanceA, 'uid:alice');
    // Sharing storage must not mean sharing budgets — alice's traffic cannot
    // rate-limit bob.
    expect((await hit(instanceB, 'uid:bob')).totalHits).toBe(1);
  });

  it('TEST-REDIS-007b — anonymous IP buckets stay separate too', async () => {
    const storage = newInstance();
    await hit(storage, 'ip:112.198.1.9');
    expect((await hit(storage, 'ip:112.198.1.10')).totalHits).toBe(1);
  });
});

describe('TEST-REDIS-008 — Redis unavailable never degrades to memory', () => {
  it('EC: an unreachable URL still resolves to the redis path, never memory', () => {
    // Reachability is not the decision input — configuration is. A dead Redis
    // must surface as errors and alerts, not as silently weaker limits that
    // differ per instance exactly when the infrastructure is already in
    // trouble. This is the failure policy, pinned.
    const d = resolveThrottlerStorage({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://unreachable.invalid:6379',
    });
    expect(d.kind).toBe('redis');
  });

  it('EC: a real Redis dying mid-run makes increment REJECT, not quietly pass', async () => {
    // The dangerous alternative would be a storage layer that swallows the
    // error and returns a fresh count — every instance would then start
    // counting from zero on its own, which is B2 again and invisible.
    const server = new RedisMemoryServer();
    const host = await server.getHost();
    const port = await server.getPort();

    const client = new Redis(port, host, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on('error', () => undefined); // keep the harness quiet
    await client.connect();
    const storage = new ThrottlerStorageRedisService(client);

    // Works while Redis is up.
    await expect(
      storage.increment('uid:alice', 60_000, 5, 60_000, 'default'),
    ).resolves.toMatchObject({ totalHits: 1 });

    await server.stop();

    await expect(
      storage.increment('uid:alice', 60_000, 5, 60_000, 'default'),
    ).rejects.toThrow();

    client.disconnect();
  }, 60_000);
});
