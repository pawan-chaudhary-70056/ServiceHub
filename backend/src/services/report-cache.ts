import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { recordCacheOperation } from './metrics.service';

/**
 * Dashboard aggregate cache (`docs/30` §3.4: "Cache — dashboard aggregates — short TTL,
 * invalidated on write of that class").
 *
 * The class cached here is the *operational dashboard* of `30` §3.1: "open requests by
 * priority", the SLA state, the task load, the approval backlog. Those are read repeatedly
 * by many people and change only when work moves — the exact shape a short-TTL cache
 * exists for. They are also the metrics that aggregate **in the database** (`§3.4`), so a
 * miss is one cheap indexed aggregate rather than a table scan.
 *
 * `notifications.delivery` is deliberately **not** cached, and the reason is in the rules:
 * its writes come from the outbox drain (`docs/29` §3), which runs continuously, so
 * "invalidate on write of that class" would evict the entry as fast as the worker fills
 * it. It stays a live indexed query in the `§3.4` "live query" row.
 *
 * Design choices, each traceable to the rule it satisfies:
 *
 *   - **Scope is part of the key.** A report is scoped by the caller's authorization
 *     (`§3.2` R3), so the entry key carries `scope`, the caller id and their team ids. One
 *     caller's figures can never be served to another — a shared entry for a
 *     permission-filtered aggregate is the reporting equivalent of a missing predicate.
 *   - **Period is part of the key.** Two windows are two different questions; the key
 *     carries the exact `from`/`to` instants the report was run under (`R2`).
 *   - **Short TTL, no jitter needed.** The TTL is a single bound from config (§3.4
 *     "short TTL") and every entry expires. Entries are per-view, so an expiry stampede is
 *     a handful of indexed aggregates, not the expensive fan-out `33` §5.2 warns about.
 *   - **Invalidation in the write's own pathway.** Every mutation of a cached class calls
 *     {@link invalidateReportCache} *after* its transaction commits, so a reader cannot
 *     repopulate from pre-commit data between the write and the invalidation — the same
 *     guarantee `catalog-cache.ts` documents for C3.
 *   - **Degrade, never fail.** Reads and writes go through `redisCommand`, which returns
 *     `null` instead of throwing: a cache outage is a miss, never a failed report (`33`
 *     C4). Without a shared tier (local development, tests) an in-process store with
 *     identical semantics is used, and staleness is bounded by the TTL alone.
 *
 * **Invalidation is a generation counter, not a key delete.** The view keys of a region are
 * unbounded (every metric/scope/period combination is one entry), so deleting them would
 * need a `SCAN`-and-delete that races with concurrent readers. Each region instead has a
 * per-tenant generation: an entry is stored under the generation it was written with, and a
 * write bumps the generation. Old entries become unreachable at once and expire on their
 * own TTL, so invalidation is O(1) and cannot race.
 */

/**
 * The cached classes. Each region is one row of the reporting catalogue's *owner*, so a
 * write is invalidated against the class it actually changed (`§3.4`) rather than against
 * "reporting" as a whole: a task mutation must not evict the request figures.
 */
export const REPORT_REGIONS = [
  'report.requests',
  'report.incidents',
  'report.tasks',
  'report.sla',
  'report.approvals',
] as const;
export type ReportRegion = (typeof REPORT_REGIONS)[number];

/**
 * Generation keys outlive any entry TTL (entries are bounded by the TTL below; this is
 * days), refreshed on every invalidation. A generation key that did expire would orphan
 * live entries until their own TTL — a miss, never a stale hit, because entries are keyed
 * *under* the generation they were written with.
 */
const GENERATION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Local store, used only when no shared cache is configured (`33` C4). */
const localGenerations = new Map<string, number>();
const localEntries = new Map<string, { value: string; expiresAt: number }>();

/** Sweeps expired local entries when the map grows, so memory stays bounded by TTL × traffic. */
const LOCAL_ENTRY_LIMIT = 2_000;

function usesSharedStore(): boolean {
  return isRedisConfigured();
}

function generationKey(region: ReportRegion, organizationId: string): string {
  return redisKey('report', 'generation', region, organizationId);
}

function entryKey(
  region: ReportRegion,
  organizationId: string,
  generation: string,
  viewKey: string,
): string {
  return redisKey('report', region, organizationId, `g${generation}`, viewKey);
}

function sweepLocalEntries(): void {
  if (localEntries.size <= LOCAL_ENTRY_LIMIT) return;
  const now = Date.now();
  for (const [key, entry] of localEntries) {
    if (entry.expiresAt <= now) localEntries.delete(key);
  }
  // Still over the limit after a sweep: entries are valid but varied in key; drop the
  // oldest half by insertion order, which Map iteration preserves.
  if (localEntries.size > LOCAL_ENTRY_LIMIT) {
    const doomed = Math.floor(localEntries.size / 2);
    let index = 0;
    for (const key of localEntries.keys()) {
      if (index++ >= doomed) break;
      localEntries.delete(key);
    }
  }
}

async function currentGeneration(region: ReportRegion, organizationId: string): Promise<string> {
  if (usesSharedStore()) {
    const generation = await redisCommand({ operation: 'report.generation.get' }, (redis) =>
      redis.get(generationKey(region, organizationId)),
    );
    // A missing key is generation "0": entries written before the first invalidation live
    // under g0 and are invalidated by the first bump to 1.
    return generation ?? '0';
  }
  return String(localGenerations.get(generationKey(region, organizationId)) ?? 0);
}

export interface ReportCacheRead {
  region: ReportRegion;
  organizationId: string;
  /**
   * The metric + scope + period dimension of the entry, within one tenant. It must already
   * encode everything that makes two reports different answers (`30` R2/R3) — this helper
   * never inspects it.
   */
  viewKey: string;
  /** Loads and serialises the payload on a miss. Errors propagate: a failed report is not cached. */
  load: () => Promise<string>;
}

/**
 * Read-through for one dashboard aggregate.
 *
 * Returns the serialised payload — cached or freshly loaded. The caller parses it, because
 * the cached and freshly-built payloads must be the *same* serialised shape; a second shape
 * that exists only on one side of a cache is how cache bugs survive tests.
 */
export async function readReportRegion(read: ReportCacheRead): Promise<string> {
  const generation = await currentGeneration(read.region, read.organizationId);
  const key = entryKey(read.region, read.organizationId, generation, read.viewKey);

  if (usesSharedStore()) {
    const cached = await redisCommand({ operation: 'report.get' }, (redis) => redis.get(key));
    if (cached !== null && cached !== undefined) {
      recordCacheOperation(read.region, 'hit');
      return cached;
    }
  } else {
    const entry = localEntries.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      recordCacheOperation(read.region, 'hit');
      return entry.value;
    }
    if (entry) localEntries.delete(key);
  }

  recordCacheOperation(read.region, 'miss');
  const payload = await read.load();
  const ttlMs = reportCacheTtlSeconds() * 1_000;

  if (usesSharedStore()) {
    await redisCommand({ operation: 'report.set' }, (redis) =>
      redis.set(key, payload, 'PX', ttlMs),
    );
  } else {
    localEntries.set(key, { value: payload, expiresAt: Date.now() + ttlMs });
    sweepLocalEntries();
  }

  return payload;
}

/**
 * Invalidates one or more cached classes for a tenant, and is called **after** the write's
 * transaction commits (`§3.4`, the same post-commit rule `catalog-cache.ts` follows).
 *
 * Over-invalidation is safe and under-invalidation is not, so a mutation that touches two
 * classes names both: fulfilling a request moves the request figures *and* stops its SLA
 * clock. With no regions given it invalidates every region, which is what a write whose
 * class cannot be narrowed to one figure (the SLA sweep stamping breaches) should do.
 *
 * It never throws: with the shared tier down, entries simply age out on their TTL (`33` C4).
 */
export async function invalidateReportCache(
  organizationId: string,
  ...regions: ReportRegion[]
): Promise<void> {
  const targets = regions.length > 0 ? regions : REPORT_REGIONS;
  for (const region of targets) {
    if (usesSharedStore()) {
      await redisCommand({ operation: 'report.generation.incr' }, async (redis) => {
        const key = generationKey(region, organizationId);
        const generation = await redis.incr(key);
        await redis.expire(key, GENERATION_TTL_SECONDS);
        return generation;
      });
    } else {
      const key = generationKey(region, organizationId);
      localGenerations.set(key, (localGenerations.get(key) ?? 0) + 1);
    }
    recordCacheOperation(region, 'invalidation');
  }
}

/**
 * Test-only: drops the in-process store. The shared tier has no equivalent because it is
 * versioned by generation, but a suite that truncates tables bypasses every service
 * mutation — and therefore every invalidation — so it must be able to start clean.
 */
export function resetReportCache(): void {
  localGenerations.clear();
  localEntries.clear();
}

/** Exposed so config stays the single source of the region TTL (`§3.4`). */
export function reportCacheTtlSeconds(): number {
  return config.REPORT_CACHE_TTL_SECONDS;
}
