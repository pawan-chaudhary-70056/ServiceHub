import { Redis } from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Shared Redis client and degradation policy (`ADR-0001`, `ADR-0003`, docs/33 C4).
 *
 * Redis is the shared cache/broker: server-side sessions and rate-limit counters must be
 * visible to every instance, so per-process state is not an option behind a load
 * balancer. But Redis is **best-effort** for the request path: rule C4 says a cache
 * outage must degrade to the database, never fail a request. This module is where that
 * promise is kept — every call goes through `redisCommand`, which never throws and
 * returns `null` when Redis is unavailable, so callers fall back rather than fail.
 *
 * A small circuit breaker sits on top. Without one, a Redis outage means every request
 * waits for a connection timeout and logs a line, turning a cache degradation into a
 * latency and log-volume incident. After a few consecutive failures the breaker opens
 * for a cooldown, so calls fail fast until Redis is retried.
 *
 * Key namespaces must not collide (`ADR-0003` consequences): sessions and rate-limit
 * counters are prefixed distinctly under one application namespace.
 */

/** Application-wide key prefix, so ServiceHub keys are identifiable and separable. */
export const KEY_PREFIX = 'servicehub';

/** Distinct namespaces, because sessions and counters share one Redis (`ADR-0003`). */
export const REDIS_NAMESPACE = {
  SESSION: 'session',
  RATE_LIMIT: 'ratelimit',
} as const;

/** Builds a fully-qualified key: `servicehub:<namespace>:<parts…>`. */
export function redisKey(namespace: string, ...parts: Array<string | number>): string {
  return [KEY_PREFIX, namespace, ...parts].join(':');
}

/** Bumped when the cached shape changes, so stale entries are ignored rather than misread. */
export const CACHE_SCHEMA_VERSION = 'v1';

const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 10_000;

let client: Redis | null = null;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** Whether a shared cache is configured at all (false only in local/test environments). */
export function isRedisConfigured(): boolean {
  return Boolean(config.REDIS_URL);
}

/**
 * The process-wide client, created on first use.
 *
 * One client per process: ioredis pools and multiplexes internally, and multiple clients
 * multiply connections against the same server for no benefit.
 *
 * `maxRetriesPerRequest: 1` bounds how long a command waits while Redis is unreachable
 * (it rejects after the first failed attempt), which lets the breaker measure real
 * failures rather than hangs. The offline queue stays enabled so a command issued in the
 * brief window before the socket reports ready is queued and served on connect instead
 * of failing — otherwise every cold start would spuriously trip the breaker.
 */
export function getRedisClient(): Redis | null {
  if (!config.REDIS_URL) {
    return null;
  }

  client ??= createClient(config.REDIS_URL);
  return client;
}

/** Exposed so tests can build an isolated client without touching the singleton. */
export function createClient(url: string): Redis {
  const instance = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    connectTimeout: 2_000,
    // Reconnect with a bounded backoff; the breaker already shields callers meanwhile.
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    lazyConnect: false,
  });

  // ioredis requires an 'error' listener; without one an emit becomes an unhandled
  // error and would crash the process. Log at warn — a cache error is not fatal (C4).
  instance.on('error', (error: Error) => {
    logger.warn({ err: error }, 'Redis client error; degrading gracefully');
  });

  return instance;
}

export interface RedisCommandOptions {
  /** Labels the operation in logs; never includes the key value (which may be sensitive). */
  operation: string;
}

/**
 * Runs a Redis command with graceful degradation.
 *
 * Returns the command's result, or `null` when Redis is unconfigured, the circuit is
 * open, or the command fails. It never throws, so a caller can always fall back to the
 * database without a try/catch of its own.
 */
export async function redisCommand<T>(
  options: RedisCommandOptions,
  run: (client: Redis) => Promise<T>,
): Promise<T | null> {
  const instance = getRedisClient();
  if (!instance) {
    return null;
  }

  if (Date.now() < breakerOpenUntil) {
    return null;
  }

  try {
    const result = await run(instance);
    consecutiveFailures = 0;
    return result;
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      consecutiveFailures = 0;
      logger.error(
        { err: error, operation: options.operation },
        'Redis unavailable; opening circuit and degrading to the database',
      );
    } else {
      logger.warn({ err: error, operation: options.operation }, 'Redis operation failed');
    }
    return null;
  }
}

/** Whether the breaker is currently open (Redis being skipped). */
export function isRedisCircuitOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

/** Cheap liveness probe for the dependency report — never used for readiness (docs/34 §6). */
export async function pingRedis(): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false;
  }
  const result = await redisCommand({ operation: 'ping' }, (instance) => instance.ping());
  return result === 'PONG';
}

/** Releases the connection on graceful shutdown (docs/35 §6). */
export async function disconnectRedis(): Promise<void> {
  if (!client) {
    return;
  }
  const instance = client;
  client = null;
  try {
    await instance.quit();
  } catch {
    // A connection already gone is not an error during shutdown.
    instance.disconnect();
  }
}
