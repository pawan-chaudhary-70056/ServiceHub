import express from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../src/integrations/redis';
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  rateLimitKey,
} from '../src/integrations/rate-limit-store';
import { errorHandler } from '../src/middlewares/error-handler';
import { createRateLimiter } from '../src/middlewares/rate-limit';
import {
  deserializeSession,
  invalidateSessionCache,
  readCachedSession,
  serializeSession,
  writeCachedSession,
} from '../src/services/session-cache';
import type { SessionWithUser } from '../src/models';

/**
 * Shared-store tests (`ADR-0001`, `ADR-0003`, docs/33 §5–§6).
 *
 * Redis-backed cases run against a real redis-server on an isolated database index and
 * skip cleanly when none is reachable; the pure serialisation and failure-policy cases
 * always run. Using a real Redis matters here: the counter's atomicity and TTL are the
 * behaviour under test, and a mock would assert neither.
 */

const TEST_REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';

let available = false;
let client: Redis | undefined;

function redis(): Redis {
  if (!client) {
    throw new Error('Redis client is not available.');
  }
  return client;
}

function gated(name: string, fn: () => Promise<void> | void): void {
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
    }
    await fn();
  });
}

function makeSession(tokenHash: string): SessionWithUser {
  const now = Date.now();
  return {
    id: 'session_1',
    userId: 'user_1',
    tokenHash,
    csrfSecretHash: 'csrf-secret-digest',
    createdAt: new Date(now),
    lastSeenAt: new Date(now),
    idleExpiresAt: new Date(now + 30 * 60_000),
    absoluteExpiresAt: new Date(now + 12 * 3_600_000),
    revokedAt: null,
    sourceIp: null,
    userAgent: null,
    user: {
      id: 'user_1',
      organizationId: 'org_1',
      email: 'user@example.test',
      displayName: 'Example User',
      status: 'ACTIVE',
      timeZone: 'UTC',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  } as unknown as SessionWithUser;
}

beforeAll(async () => {
  try {
    client = createClient(TEST_REDIS_URL);
    await client.ping();
    // Isolated index: safe to clear so a leftover counter cannot affect a run.
    await client.flushdb();
    available = true;
  } catch {
    available = false;
    client?.disconnect();
    client = undefined;
  }
});

afterAll(async () => {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
  }
});

describe('RedisRateLimitStore', () => {
  gated('shares one counter across instances so the limit is not multiplied', async () => {
    const key = rateLimitKey('test:shared:60000', `ip-${Date.now()}`);
    const instanceA = new RedisRateLimitStore(redis());
    const instanceB = new RedisRateLimitStore(redis());

    const first = await instanceA.increment(key, 60_000, Date.now());
    const second = await instanceB.increment(key, 60_000, Date.now());

    expect(first?.count).toBe(1);
    expect(second?.count).toBe(2);
  });

  gated('sets an expiry so a counter cannot block forever', async () => {
    const key = rateLimitKey('test:ttl:60000', `ip-${Date.now()}`);
    const store = new RedisRateLimitStore(redis());
    const now = Date.now();

    const outcome = await store.increment(key, 60_000, now);
    expect(outcome).not.toBeNull();
    // The window resets in the future and within the configured window.
    expect(outcome!.resetAtMs).toBeGreaterThan(now);
    expect(outcome!.resetAtMs).toBeLessThanOrEqual(now + 60_000);

    const pttl = await redis().pttl(key);
    expect(pttl).toBeGreaterThan(0);
  });

  gated('returns null (not an error) when the store cannot be reached', async () => {
    // A client pointed at a closed port fails fast (offline queue disabled).
    const dead = createClient('redis://localhost:6399/0');
    const store = new RedisRateLimitStore(dead);

    const outcome = await store.increment(rateLimitKey('test:dead:1', 'x'), 60_000, Date.now());
    expect(outcome).toBeNull();

    dead.disconnect();
  });
});

describe('MemoryRateLimitStore (local/test fallback)', () => {
  it('counts within a window and resets after it', async () => {
    const store = new MemoryRateLimitStore();
    const now = Date.now();

    expect((await store.increment('k', 1_000, now))?.count).toBe(1);
    expect((await store.increment('k', 1_000, now + 100))?.count).toBe(2);
    // A new window starts after the previous one expired.
    expect((await store.increment('k', 1_000, now + 2_000))?.count).toBe(1);
  });
});

describe('session cache serialisation', () => {
  it('round-trips a session, reviving its dates', () => {
    const session = makeSession('hash-round-trip');
    const revived = deserializeSession(serializeSession(session));

    expect(revived).not.toBeNull();
    expect(revived!.idleExpiresAt).toBeInstanceOf(Date);
    expect(revived!.idleExpiresAt.getTime()).toBe(session.idleExpiresAt.getTime());
    expect(revived!.user.status).toBe('ACTIVE');
  });

  it('treats a corrupt or version-mismatched entry as a miss', () => {
    expect(deserializeSession('not-json')).toBeNull();
    expect(deserializeSession(JSON.stringify({ v: 'v0', s: makeSession('h') }))).toBeNull();
    expect(deserializeSession(JSON.stringify({ v: 'v1', s: {} }))).toBeNull();
  });

  it('degrades quietly when no Redis is configured', async () => {
    // With REDIS_URL unset in the test environment, the cache is a no-op, not a failure.
    await expect(writeCachedSession(makeSession('hash-no-redis'))).resolves.toBeUndefined();
    await expect(readCachedSession('hash-no-redis')).resolves.toBeNull();
    await expect(invalidateSessionCache('hash-no-redis')).resolves.toBeUndefined();
  });
});

describe('session cache against Redis', () => {
  gated('writes, reads and invalidates a session entry', async () => {
    const session = makeSession(`hash-${Date.now()}`);
    const store = redis();

    await writeCachedSession(session, store);

    const cached = await readCachedSession(session.tokenHash, store);
    expect(cached).not.toBeNull();
    expect(cached!.idleExpiresAt.getTime()).toBe(session.idleExpiresAt.getTime());

    await invalidateSessionCache(session.tokenHash, store);
    expect(await readCachedSession(session.tokenHash, store)).toBeNull();
  });
});

describe('rate-limit middleware failure policy', () => {
  function appWith(store: { increment: () => Promise<null> }, failureMode: 'open' | 'closed') {
    const app = express();
    app.use(createRateLimiter({ windowMs: 60_000, max: 5, store, failureMode }));
    app.get('/x', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    // The single error contract (docs/11 §4) is what turns the limiter's error into the
    // documented status, so the test app carries it exactly as the real app does.
    app.use(errorHandler);
    return app;
  }

  it('fails closed with 503 when the credential surface cannot count', async () => {
    const failingStore = { increment: async () => null };
    const response = await request(appWith(failingStore, 'closed')).get('/x');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('fails open (allows) for the general surface when the store is down', async () => {
    const failingStore = { increment: async () => null };
    const response = await request(appWith(failingStore, 'open')).get('/x');

    expect(response.status).toBe(200);
  });

  it('returns 429 with Retry-After when the limit is exceeded', async () => {
    const app = express();
    app.use(createRateLimiter({ windowMs: 60_000, max: 2, store: new MemoryRateLimitStore() }));
    app.get('/x', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(errorHandler);

    await request(app).get('/x').expect(200);
    await request(app).get('/x').expect(200);

    const limited = await request(app).get('/x');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(limited.headers['ratelimit-limit']).toBe('2');
  });
});
