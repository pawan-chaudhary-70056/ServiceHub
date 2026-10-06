import type { Redis } from 'ioredis';
import { config } from '../config';
import {
  CACHE_SCHEMA_VERSION,
  REDIS_NAMESPACE,
  redisCommand,
  redisKey,
} from '../integrations/redis';
import type { SessionWithUser } from '../models';

/**
 * Runs a cache operation against either an injected client (tests) or the shared client
 * behind `redisCommand`. Never throws: a cache failure is a miss (docs/33 C4).
 */
async function run<T>(
  client: Redis | undefined,
  operation: string,
  execute: (redis: Redis) => Promise<T>,
): Promise<T | null> {
  if (client) {
    return execute(client).catch(() => null);
  }
  return redisCommand({ operation }, execute);
}

/**
 * Session-lookup cache (`ADR-0001`, `docs/33` §5 region “session lookups”).
 *
 * The durable, revocable record is the `sessions` row. Redis holds a **shared, hot
 * copy** so any instance can resolve a session without a database round trip, which is
 * what makes the “shared store” property of `ADR-0001` true while keeping revocation
 * durable: if Redis is flushed or lost, a session is re-read from PostgreSQL — and a
 * revoked session can never reappear, because the source of truth is the row, not the
 * cache.
 *
 * The rules this module obeys:
 *   - C2: an explicit, bounded TTL on every write, capped by the session's own absolute
 *     expiry so a cache entry never outlives the session it describes.
 *   - C3: explicit invalidation on revocation, in the same pathway as the write.
 *   - C4: a cache outage degrades to the database and never fails a request — every
 *     function here returns quietly when Redis is unavailable.
 *   - C6: only the session *digest* is used in the key; the raw token is never cached.
 *
 * The entry is version-tagged (`CACHE_SCHEMA_VERSION`), so a shape change ignores old
 * entries rather than misreading them.
 */

/** The Redis key for a session lookup. Keyed by the token *digest*, never the token. */
export function sessionCacheKey(tokenHash: string): string {
  return redisKey(REDIS_NAMESPACE.SESSION, CACHE_SCHEMA_VERSION, tokenHash);
}

/** Serialises a session + its identity for the cache. */
export function serializeSession(session: SessionWithUser): string {
  return JSON.stringify({ v: CACHE_SCHEMA_VERSION, s: session });
}

/**
 * Revives a cached entry, converting ISO date strings back to `Date`s.
 *
 * Returns `null` for anything malformed or version-mismatched, so a corrupt entry is a
 * cache miss (fall back to the database) rather than an error or a wrong decision.
 */
export function deserializeSession(raw: string): SessionWithUser | null {
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; s?: unknown };
    if (parsed.v !== CACHE_SCHEMA_VERSION || typeof parsed.s !== 'object' || parsed.s === null) {
      return null;
    }

    const s = parsed.s as Record<string, unknown>;
    const user = s.user as Record<string, unknown> | undefined;
    if (!user) {
      return null;
    }

    const session = {
      ...s,
      createdAt: new Date(s.createdAt as string),
      lastSeenAt: new Date(s.lastSeenAt as string),
      idleExpiresAt: new Date(s.idleExpiresAt as string),
      absoluteExpiresAt: new Date(s.absoluteExpiresAt as string),
      revokedAt: s.revokedAt ? new Date(s.revokedAt as string) : null,
      user: {
        ...user,
        createdAt: new Date(user.createdAt as string),
        updatedAt: new Date(user.updatedAt as string),
      },
    } as unknown as SessionWithUser;

    if (
      Number.isNaN(session.idleExpiresAt.getTime()) ||
      Number.isNaN(session.absoluteExpiresAt.getTime())
    ) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/** TTL for a cache write: bounded by config and never beyond the session's own expiry. */
function cacheTtlMs(session: SessionWithUser): number {
  const remaining = session.absoluteExpiresAt.getTime() - Date.now();
  const configured = config.SESSION_CACHE_TTL_SECONDS * 1_000;
  return Math.min(remaining, configured);
}

/** Reads a cached session, or `null` on a miss or when Redis is unavailable. */
export async function readCachedSession(
  tokenHash: string,
  client?: Redis,
): Promise<SessionWithUser | null> {
  const raw = await run(client, 'session.get', (redis) => redis.get(sessionCacheKey(tokenHash)));

  if (!raw) {
    return null;
  }
  return deserializeSession(raw);
}

/**
 * Caches a resolved session. Best-effort: a failure to cache must not fail the request.
 *
 * The entry is not written when the session is already expired (nothing useful to serve)
 * or when the TTL would be non-positive.
 */
export async function writeCachedSession(session: SessionWithUser, client?: Redis): Promise<void> {
  const ttl = cacheTtlMs(session);
  if (ttl <= 0) {
    return;
  }

  await run(client, 'session.set', (redis) =>
    redis.set(sessionCacheKey(session.tokenHash), serializeSession(session), 'PX', ttl),
  );
}

/** Invalidates one session's cache entry, called on revocation (C3). */
export async function invalidateSessionCache(tokenHash: string, client?: Redis): Promise<void> {
  await run(client, 'session.del', (redis) => redis.del(sessionCacheKey(tokenHash)));
}

/**
 * Invalidates several sessions at once (password reset / deactivation revoke all).
 *
 * Done with one `DEL` over the keys, rather than a per-key loop, because a revocation
 * is exactly the moment staleness must not persist.
 */
export async function invalidateSessionCaches(
  tokenHashes: readonly string[],
  client?: Redis,
): Promise<void> {
  if (tokenHashes.length === 0) {
    return;
  }
  const keys = tokenHashes.map((tokenHash) => sessionCacheKey(tokenHash));
  await run(client, 'session.delMany', (redis) => redis.del(...keys));
}
