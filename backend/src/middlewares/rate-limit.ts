import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { DependencyError, RateLimitedError } from '../utils/errors';
import { logger } from '../utils/logger';
import { isRedisConfigured } from '../integrations/redis';
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  rateLimitKey,
  type RateLimitStore,
} from '../integrations/rate-limit-store';

/**
 * Application-layer rate limiting (docs/33 §6, `ADR-0003`).
 *
 * Counters live in the **shared** Redis store, so the limit is enforced across every
 * instance — a per-instance counter is multiplied by the instance count and does not
 * limit anything (`docs/33` §6). When Redis is not configured (local/test only) an
 * in-memory store is used, and that limitation is stated rather than hidden.
 *
 * Failure policy is deliberate and asymmetric (docs/33 §6):
 *   - `failClosed` — authentication and other credential surfaces are **rejected** when
 *     the limiter cannot count, because letting a brute-force run unmetered is worse
 *     than making the caller retry.
 *   - `failOpen` — the general surface **allows** the request and logs, because a cache
 *     outage must not become an outage of the whole product (rule C4).
 *
 * Coarse limits are also applied at the edge/load balancer; this layer is finer and
 * per-route. Headers follow docs/11 §8: `RateLimit-Limit`, `RateLimit-Remaining`,
 * `RateLimit-Reset`, and `Retry-After` on rejection.
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Identifies the counter bucket. Defaults to the caller, then the IP. */
  keyGenerator?: (req: Request) => string;
  message?: string;
  /**
   * What to do when the shared store cannot count the request.
   * Defaults to `open` (graceful); authentication routes set `closed`.
   */
  failureMode?: 'open' | 'closed';
  /** Injected for tests; defaults to Redis when configured, else in-memory. */
  store?: RateLimitStore;
}

/** How often a degraded-store warning is emitted per limiter, to avoid log flooding. */
const DEGRADED_LOG_INTERVAL_MS = 10_000;

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const store =
    options.store ?? (isRedisConfigured() ? new RedisRateLimitStore() : new MemoryRateLimitStore());
  const failureMode = options.failureMode ?? 'open';
  const bucket = `${options.max}:${options.windowMs}`;

  const keyGenerator =
    options.keyGenerator ?? ((req: Request) => req.actor?.userId ?? req.ip ?? 'unknown');

  let lastDegradedLogAt = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const now = Date.now();
      const key = rateLimitKey(bucket, keyGenerator(req));

      let outcome;
      try {
        outcome = await store.increment(key, options.windowMs, now);
      } catch {
        // A store that throws is treated the same as an unavailable store.
        outcome = null;
      }

      if (!outcome) {
        if (failureMode === 'closed') {
          // Cannot count the credential surface; refuse rather than run unmetered.
          next(new DependencyError('Rate limiting is unavailable; please retry shortly.'));
          return;
        }

        // Fail open, but make the degradation visible (never silently unthrottled).
        if (now - lastDegradedLogAt > DEGRADED_LOG_INTERVAL_MS) {
          lastDegradedLogAt = now;
          logger.warn(
            { path: req.path, method: req.method },
            'Rate limiter store unavailable; allowing request (fail-open)',
          );
        }
        next();
        return;
      }

      const remaining = Math.max(0, options.max - outcome.count);
      res.setHeader('RateLimit-Limit', String(options.max));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil(outcome.resetAtMs / 1000)));

      if (outcome.count > options.max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((outcome.resetAtMs - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        next(new RateLimitedError(options.message));
        return;
      }

      next();
    })().catch(next);
  };
}
