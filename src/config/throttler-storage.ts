import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

/**
 * SEC-004 / B2 — where rate-limit counters actually live.
 *
 * The default ThrottlerStorage is process memory. That made every limit
 * per-instance: two replicas doubled the effective budget, and each deploy
 * emptied every bucket. Neither is a rate limit anyone can reason about.
 *
 * The rule this file enforces:
 *
 *   dev/test  + no REDIS_URL  ->  in-memory (unchanged local workflow)
 *   any env   +    REDIS_URL  ->  Redis/Valkey-backed
 *   PRODUCTION + no REDIS_URL ->  refuse to start
 *
 * That last line is the point. A production process that silently falls back
 * to memory is B2 again, wearing a Redis-shaped hat — and it would look
 * healthy while doing it. Better to fail at boot, where a deploy shows red,
 * than to discover it from an abuse incident.
 */

/** Thrown at bootstrap; deliberately not an HttpException. */
export class ThrottlerStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThrottlerStorageConfigError';
  }
}

export interface ThrottlerStorageDecision {
  kind: 'memory' | 'redis';
  redisUrl?: string;
  /** Human-readable reason, logged at startup so the choice is never a guess. */
  reason: string;
}

/**
 * Decide which storage to use. Pure — no connection is opened here, so this is
 * directly testable and the decision can be logged before anything dials out.
 */
export function resolveThrottlerStorage(
  env: Record<string, string | undefined> = process.env,
): ThrottlerStorageDecision {
  const redisUrl = env.REDIS_URL?.trim();
  const isProd = env.NODE_ENV === 'production';

  if (redisUrl) {
    return {
      kind: 'redis',
      redisUrl,
      reason:
        'REDIS_URL is set — rate-limit counters are shared across instances',
    };
  }

  if (isProd) {
    throw new ThrottlerStorageConfigError(
      'REDIS_URL is required in production. Rate limiting would otherwise be ' +
        'per-instance and reset on every deploy, which is the defect this ' +
        'setting exists to prevent. Point it at the Render Key Value internal ' +
        'connection URL (redis://...) for a service in the same region.',
    );
  }

  return {
    kind: 'memory',
    reason:
      'REDIS_URL not set and NODE_ENV is not production — using in-memory ' +
      'storage. Fine locally; refused in production.',
  };
}

/**
 * Build the storage for the decision, or `undefined` to let @nestjs/throttler
 * use its own in-memory default.
 *
 * On the Redis path `lazyConnect` is deliberately OFF: we want the connection
 * attempted at startup so a misconfigured URL surfaces during the deploy, not
 * on the first throttled request.
 *
 * `maxRetriesPerRequest: null` keeps commands queued through a blip rather
 * than erroring immediately. Note what this does NOT do: it never degrades to
 * local counting. If Redis is gone, throttling errors loudly and visibly —
 * chosen over silently weakening enforcement on every instance at exactly the
 * moment the infrastructure is already in trouble.
 */
export function createThrottlerStorage(
  decision: ThrottlerStorageDecision,
): ThrottlerStorage | undefined {
  if (decision.kind === 'memory') return undefined;

  const client = new Redis(decision.redisUrl!, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  return new ThrottlerStorageRedisService(client);
}
