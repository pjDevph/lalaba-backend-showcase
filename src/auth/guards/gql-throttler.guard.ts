import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { createHash } from 'node:crypto';

/** Mirrors the key GqlAuthGuard writes after a successful verifyIdToken(). */
const tokenCacheKey = (idToken: string): string =>
  `firebase_token_v2:${createHash('sha256').update(idToken).digest('hex')}`;

@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {
    super(options, storageService, reflector);
  }

  protected getRequestResponse(context: ExecutionContext) {
    // This guard is registered globally, so it also sees plain HTTP requests
    // (health check, POST /webhooks/xendit). GqlExecutionContext yields no
    // req/res for those, and the throttler then dies on `res.header` — which
    // took down every REST route. Only unwrap the GraphQL context for GraphQL.
    if (context.getType<'graphql' | 'http'>() !== 'graphql') {
      return super.getRequestResponse(context);
    }
    const gqlCtx = GqlExecutionContext.create(context);
    const ctx = gqlCtx.getContext();
    return { req: ctx.req, res: ctx.res };
  }

  /**
   * SEC-002/003 — what a rate-limit bucket is keyed on.
   *
   * The inherited implementation returns `req.ip`. On Render every request
   * arrives through the platform load balancer, so without `trust proxy` set
   * (SEC-001, see main.ts) `req.ip` is the balancer's address and EVERY caller
   * on the internet shares one bucket. That is both no rate limiting at all
   * and a self-inflicted outage: a few dozen concurrent users 429 each other
   * off the platform.
   *
   * `trust proxy` fixes `req.ip`, but IP is still the wrong key for most of
   * this API. Mobile carriers here NAT large subscriber pools behind a handful
   * of addresses, so an IP-keyed limit punishes a whole city for one abusive
   * handset. Where the caller is authenticated we can do better.
   *
   * We cannot read `req.user`: this is an APP_GUARD, and Nest runs global
   * guards BEFORE the resolver-scoped GqlAuthGuard that populates it. So the
   * caller is identified from the bearer token directly, cheapest-first:
   *
   *   1. The token cache GqlAuthGuard already maintains. A hit gives the real
   *      uid for free — no Firebase round trip, no verification here.
   *   2. A hash of the token itself. Stable for the life of that token, so a
   *      first-request-of-a-session miss still gets a private bucket rather
   *      than falling all the way back to a shared one. Never the raw token:
   *      it would end up in a cache key and, with Render Key Value, on the
   *      wire and at rest in a second system.
   *   3. The validated client IP, for genuinely anonymous operations —
   *      healthCheck, signupRoles and the two biometric pre-login mutations.
   *      That fallback is the whole abuse surface for unauthenticated traffic,
   *      which is why it must be a real client address and not the proxy's.
   *      The two halves of this fix only work together.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const authHeader: unknown = req?.headers?.authorization;

    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.slice('Bearer '.length);
      if (idToken) {
        const key = tokenCacheKey(idToken);
        try {
          const cached = await this.cache.get<{ uid?: string }>(key);
          if (cached?.uid) return `uid:${cached.uid}`;
        } catch {
          // A cache outage must not take the API down with it. Fall through to
          // the token hash, which needs nothing but the request itself.
        }
        return `tok:${key.slice(-32)}`;
      }
    }

    // `req.ip` is trustworthy only because main.ts sets `trust proxy`. Express
    // then resolves it from X-Forwarded-For; Render's balancer overwrites that
    // header rather than appending to a client-supplied one, so a caller
    // cannot spoof it by sending their own.
    const ip: unknown = req?.ip ?? req?.socket?.remoteAddress;
    return `ip:${typeof ip === 'string' ? ip : 'unknown'}`;
  }
}
