import type { Redis } from 'ioredis';
import { redisCommand, redisKey, REDIS_NAMESPACE } from './redis';

/**
 * Rate-limit counter stores (docs/33 §6, `ADR-0003`).
 *
 * The counter must be **shared**: a limit that counts per instance is multiplied by the
 * number of instances, so an attacker simply spreads requests (docs/33 §6). The Redis
 * store is therefore the production path; the in-memory store exists only for local and
 * test runs where no Redis is configured.
 *
 * `increment` returns `null` — rather than throwing — when the shared store cannot be
 * reached, so the middleware can apply the failure policy (`failClosed`) rather than a
 * cache outage becoming a 500.
 */

export interface RateLimitOutcome {
  /** Count after this increment. */
  count: number;
  /** Absolute epoch-ms when the window expires, for `RateLimit-Reset`/`Retry-After`. */
  resetAtMs: number;
}

export interface RateLimitStore {
  /**
   * Atomically increments the counter for `key` within `windowMs`.
   *
   * Returns `null` when the store is unavailable (Redis down or circuit open).
   */
  increment(key: string, windowMs: number, nowMs: number): Promise<RateLimitOutcome | null>;
}

/**
 * Fixed-window counter in Redis.
 *
 * `INCR` then `PEXPIRE`-on-first-write must be atomic, or a crash between the two leaves
 * a counter with no expiry — a permanent block. A Lua script makes the pair one
 * operation on the server, which is why it is used instead of two round trips.
 */
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
return {count, pttl}
`;

export class RedisRateLimitStore implements RateLimitStore {
  /**
   * @param client Optional client, for tests and non-singleton use. When omitted the
   *   shared client behind `redisCommand` (with the circuit breaker) is used.
   */
  constructor(private readonly client?: Redis) {}

  increment(key: string, windowMs: number, nowMs: number): Promise<RateLimitOutcome | null> {
    const execute = async (client: Redis): Promise<RateLimitOutcome> => {
      const result = (await client.eval(INCREMENT_SCRIPT, 1, key, String(windowMs))) as [
        number,
        number,
      ];

      const count = Number(result[0]);
      const pttl = Number(result[1]);
      const resetAtMs = pttl > 0 ? nowMs + pttl : nowMs + windowMs;
      return { count, resetAtMs };
    };

    if (this.client) {
      return execute(this.client).catch(() => null);
    }
    return redisCommand({ operation: 'rate-limit' }, execute);
  }
}

/**
 * Process-local counter, used **only** when Redis is not configured (local/test).
 *
 * It is deliberately not a fallback for a Redis *outage*: falling back to a per-instance
 * counter would silently multiply the limit, which is worse than failing per policy
 * (`docs/33` §6). The outage path is handled by the middleware's `failClosed` choice.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, { count: number; resetAtMs: number }>();

  async increment(key: string, windowMs: number, nowMs: number): Promise<RateLimitOutcome> {
    // Opportunistic cleanup keeps the map bounded without a background timer.
    if (this.counters.size > 10_000) {
      for (const [existingKey, counter] of this.counters) {
        if (counter.resetAtMs <= nowMs) {
          this.counters.delete(existingKey);
        }
      }
    }

    const existing = this.counters.get(key);
    const counter =
      existing && existing.resetAtMs > nowMs ? existing : { count: 0, resetAtMs: nowMs + windowMs };

    counter.count += 1;
    this.counters.set(key, counter);

    return { count: counter.count, resetAtMs: counter.resetAtMs };
  }
}

/** Bumped when the counter key shape changes, so old counters are not misread. */
const CACHE_VERSION = 'v1';

/** A stable namespaced key for a rate-limit bucket (tenant/identity agnostic). */
export function rateLimitKey(bucket: string, identity: string): string {
  return redisKey(REDIS_NAMESPACE.RATE_LIMIT, CACHE_VERSION, bucket, identity);
}
