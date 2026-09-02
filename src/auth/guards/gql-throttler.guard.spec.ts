import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { GqlThrottlerGuard } from './gql-throttler.guard';

/**
 * SEC-005 — the bucket identity, which is the whole of B1.
 *
 * Every case here fails against the inherited `getTracker` (which returns
 * `req.ip` unconditionally) once `trust proxy` is in play, because every
 * request then carries the same balancer address.
 */

// getTracker is protected; this is the seam for testing it.
type TrackerProbe = { getTracker(req: Record<string, any>): Promise<string> };

const PROXY_IP = '10.201.4.7'; // what Render's balancer looks like

const makeGuard = (tokenToUid: Record<string, string> = {}) => {
  const cache = {
    get: jest.fn((key: string) => {
      const uid = tokenToUid[key];
      return Promise.resolve(uid ? { uid } : undefined);
    }),
  };
  const guard = new GqlThrottlerGuard(
    [{ ttl: 60000, limit: 100 }],
    { increment: jest.fn() },
    new Reflector(),
    cache as never,
  );
  return { guard: guard as unknown as TrackerProbe, cache };
};

const cacheKeyFor = (token: string) =>
  `firebase_token_v2:${createHash('sha256').update(token).digest('hex')}`;

const req = (token?: string, ip = PROXY_IP) => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
  ip,
});

describe('bucket identity', () => {
  it('HP: two signed-in users get independent buckets', async () => {
    const { guard } = makeGuard({
      [cacheKeyFor('token-alice')]: 'uid-alice',
      [cacheKeyFor('token-bob')]: 'uid-bob',
    });

    const alice = await guard.getTracker(req('token-alice'));
    const bob = await guard.getTracker(req('token-bob'));

    expect(alice).toBe('uid:uid-alice');
    expect(bob).toBe('uid:uid-bob');
    expect(alice).not.toBe(bob);
  });

  it('EC: same IP does not merge two users into one bucket', async () => {
    // The failure this whole change exists to prevent: behind Render's
    // balancer every request shares an address, so an IP-keyed tracker
    // returns one value for the entire internet.
    const { guard } = makeGuard({
      [cacheKeyFor('token-alice')]: 'uid-alice',
      [cacheKeyFor('token-bob')]: 'uid-bob',
    });

    const alice = await guard.getTracker(req('token-alice', PROXY_IP));
    const bob = await guard.getTracker(req('token-bob', PROXY_IP));

    expect(alice).not.toBe(bob);
  });

  it('HP: the same user across two requests shares one bucket', async () => {
    const { guard } = makeGuard({ [cacheKeyFor('token-alice')]: 'uid-alice' });

    expect(await guard.getTracker(req('token-alice'))).toBe(
      await guard.getTracker(req('token-alice')),
    );
  });
});

describe('unverified and anonymous callers', () => {
  it('EC: a token not yet in cache still gets its own bucket', async () => {
    const { guard } = makeGuard(); // every lookup misses

    const a = await guard.getTracker(req('token-alice'));
    const b = await guard.getTracker(req('token-bob'));

    expect(a).toMatch(/^tok:/);
    expect(a).not.toBe(b);
  });

  it('EC: the token itself never appears in the bucket key', async () => {
    const { guard } = makeGuard();
    const tracker = await guard.getTracker(req('super-secret-token'));
    expect(tracker).not.toContain('super-secret-token');
  });

  it('EC: anonymous callers fall back to the client IP', async () => {
    const { guard } = makeGuard();
    expect(await guard.getTracker(req(undefined, '112.198.1.9'))).toBe(
      'ip:112.198.1.9',
    );
  });

  it('EC: two anonymous IPs are separate buckets', async () => {
    const { guard } = makeGuard();
    const a = await guard.getTracker(req(undefined, '112.198.1.9'));
    const b = await guard.getTracker(req(undefined, '112.198.1.10'));
    expect(a).not.toBe(b);
  });

  it('EC: a malformed Authorization header is treated as anonymous', async () => {
    const { guard } = makeGuard();
    const tracker = await guard.getTracker({
      headers: { authorization: 'Basic abc123' },
      ip: '112.198.1.9',
    });
    expect(tracker).toBe('ip:112.198.1.9');
  });

  it('EC: an empty bearer token is treated as anonymous', async () => {
    const { guard } = makeGuard();
    const tracker = await guard.getTracker({
      headers: { authorization: 'Bearer ' },
      ip: '112.198.1.9',
    });
    expect(tracker).toBe('ip:112.198.1.9');
  });

  it('EC: no IP at all still yields a usable key rather than throwing', async () => {
    const { guard } = makeGuard();
    expect(await guard.getTracker({ headers: {} })).toBe('ip:unknown');
  });
});

describe('resilience', () => {
  it('EC: a cache outage degrades to the token bucket, it does not throw', async () => {
    const { guard, cache } = makeGuard();
    cache.get.mockRejectedValueOnce(new Error('Key Value unreachable'));

    const tracker = await guard.getTracker(req('token-alice'));

    // Still per-caller, just derived without the cache — the API stays up.
    expect(tracker).toMatch(/^tok:/);
  });
});
