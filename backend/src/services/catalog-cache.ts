import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { recordCacheOperation } from './metrics.service';

/**
 * Catalog cache regions (`docs/21` §10, `docs/33` §5.1 "category tree, active catalog
 * items", rules C1–C8).
 *
 * The two regions are the two rows of `21` §10's table — the category tree (long TTL)
 * and the catalog item list (medium TTL). Item **detail** is deliberately not here: the
 * same table marks admin detail "not cached", and a detail read is a single indexed
 * lookup rather than the list fan-out caching exists for.
 *
 * The design choices, each traced to a rule:
 *
 *   - **C1 — never a permission-filtered view under a shared key.** The category tree is
 *     cached *unfiltered* and the viewer's `includeInactive` filter is applied after the
 *     cache read (the stronger of the two options `21` §10 offers). The item list cannot
 *     be unfiltered without leaking draft/retired rows into a requester's page, so its
 *     key carries the viewer class instead (`manager` vs `requester`).
 *   - **C2/C7 — explicit, jittered TTLs.** Every entry expires; the ±10 % jitter keeps a
 *     popular key from collapsing back onto the database in the same instant across
 *     instances. Single-flight does not apply: these are cheap indexed reads, not the
 *     "expensive keys" C7 names, so a stampede on expiry is a handful of fast queries.
 *   - **C3 — invalidation in the write's own pathway.** Every catalog mutation calls
 *     {@link invalidateCatalogCache} after its transaction commits, so a reader cannot
 *     repopulate from pre-commit data between the write and the invalidation.
 *   - **C4 — best effort.** Reads/writes go through `redisCommand`, which returns `null`
 *     instead of throwing; a cache outage is a miss, never a failed request.
 *   - **C5 — the key carries the tenant.** Every key embeds `organizationId`, so no
 *     region can cross a tenant boundary even under a key-collision bug.
 *
 * **Invalidation is a generation counter, not a key delete.** The item list's keys are
 * unbounded (every filter/cursor combination is one key), so deleting them on a write
 * would need a `SCAN`-and-delete that races with concurrent writers. Instead each region
 * has a per-tenant generation: an entry is keyed by the generation it was written under,
 * and a write bumps the generation. Old entries become unreachable at once and expire on
 * their own TTL — invalidation is O(1) and cannot race.
 *
 * **Two stores, one contract.** With Redis configured the generation and the entries are
 * shared, so a write on instance A invalidates instance B immediately. Without Redis
 * (local development, tests) an in-process store with identical semantics is used, and
 * staleness is bounded by the TTL alone — which is exactly what C2 promises when there
 * is no shared tier (`33` §5, C4: the app degrades, it does not fail).
 */

/** The regions `21` §10 defines. Fixed set — the metric label is low-cardinality. */
export const CATALOG_REGIONS = ['catalog.categories', 'catalog.items'] as const;
export type CatalogRegion = (typeof CATALOG_REGIONS)[number];

/**
 * Generation keys outlive any entry TTL (entries are bounded by minutes; this is days),
 * refreshed on every invalidation. If a generation key did expire, the worst case is a
 * generation reset that orphans live entries until their own TTL — a miss, never a stale
 * hit, because entries are keyed *under* the generation they were written with.
 */
const GENERATION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Local store, used only when no shared cache is configured (C4). */
const localGenerations = new Map<string, number>();
const localEntries = new Map<string, { value: string; expiresAt: number }>();

/** Sweeps expired local entries when the map grows, so memory stays bounded by TTL × traffic. */
const LOCAL_ENTRY_LIMIT = 5_000;

function usesSharedStore(): boolean {
  return isRedisConfigured();
}

function generationKey(region: CatalogRegion, organizationId: string): string {
  return redisKey('catalog', 'generation', region, organizationId);
}

function entryKey(
  region: CatalogRegion,
  organizationId: string,
  generation: string,
  viewKey: string,
): string {
  return redisKey('catalog', region, organizationId, `g${generation}`, viewKey);
}

/** ±10 % jitter (C7): one popular key must not expire everywhere at the same instant. */
function jitteredTtlSeconds(ttlSeconds: number): number {
  return Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
}

function sweepLocalEntries(): void {
  if (localEntries.size <= LOCAL_ENTRY_LIMIT) return;
  const now = Date.now();
  for (const [key, entry] of localEntries) {
    if (entry.expiresAt <= now) localEntries.delete(key);
  }
  // Still over the limit after a sweep: entries are valid but unbounded in key variety;
  // drop the oldest half by insertion order, which Map iteration preserves.
  if (localEntries.size > LOCAL_ENTRY_LIMIT) {
    const doomed = Math.floor(localEntries.size / 2);
    let index = 0;
    for (const key of localEntries.keys()) {
      if (index++ >= doomed) break;
      localEntries.delete(key);
    }
  }
}

async function currentGeneration(region: CatalogRegion, organizationId: string): Promise<string> {
  if (usesSharedStore()) {
    const generation = await redisCommand({ operation: 'catalog.generation.get' }, (redis) =>
      redis.get(generationKey(region, organizationId)),
    );
    // A missing key is generation "0": entries written before the first invalidation
    // live under g0 and are invalidated by the first bump to 1.
    return generation ?? '0';
  }
  return String(localGenerations.get(generationKey(region, organizationId)) ?? 0);
}

export interface CatalogCacheRead {
  region: CatalogRegion;
  organizationId: string;
  /**
   * The viewer/filter dimension of the entry, within one tenant. Must already encode the
   * viewer class where the data is permission-filtered (C1) — the helper never sees it.
   */
  viewKey: string;
  /** Explicit region TTL from config (C2); jitter is applied here. */
  ttlSeconds: number;
  /** Loads and serialises the payload on a miss. Errors propagate: a failed read is not cached. */
  load: () => Promise<string>;
}

/**
 * Read-through for one catalog region entry.
 *
 * Returns the serialised payload — either the cached one or a fresh load. The caller
 * parses, because the cached and freshly-built payloads must be the *same* serialised
 * shape; a second shape only exists on one side of a cache and that asymmetry is how
 * cache bugs survive tests.
 */
export async function readCatalogRegion(read: CatalogCacheRead): Promise<string> {
  const generation = await currentGeneration(read.region, read.organizationId);
  const key = entryKey(read.region, read.organizationId, generation, read.viewKey);

  if (usesSharedStore()) {
    const cached = await redisCommand({ operation: 'catalog.get' }, (redis) => redis.get(key));
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
  const ttlMs = jitteredTtlSeconds(read.ttlSeconds) * 1_000;

  if (usesSharedStore()) {
    await redisCommand({ operation: 'catalog.set' }, (redis) =>
      redis.set(key, payload, 'PX', ttlMs),
    );
  } else {
    localEntries.set(key, { value: payload, expiresAt: Date.now() + ttlMs });
    sweepLocalEntries();
  }

  return payload;
}

/**
 * Invalidates both catalog regions for one tenant (C3; `21` §10's "on any category
 * mutation" and "on item activation/retirement/edit").
 *
 * Both regions move together, deliberately: an item mutation changes the per-category
 * counts in the tree *and* the item list, and a category rename changes the
 * `categoryName` denormalised into list rows. One invariant — "any catalog mutation
 * invalidates the catalog" — cannot be got half-right the way two per-region rules can.
 * It never throws: with the shared tier down, entries simply age out on their TTL (C4).
 */
export async function invalidateCatalogCache(organizationId: string): Promise<void> {
  for (const region of CATALOG_REGIONS) {
    if (usesSharedStore()) {
      await redisCommand({ operation: 'catalog.generation.incr' }, async (redis) => {
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
 * Test-only: drops the in-process store. The shared tier has no equivalent because it
 * is versioned by generation, but a suite that truncates tables bypasses every service
 * mutation — and therefore every invalidation — so it must be able to start clean.
 */
export function resetCatalogCache(): void {
  localGenerations.clear();
  localEntries.clear();
}

/** Exposed so config stays the single source of region TTLs (C2). */
export function catalogRegionTtlSeconds(region: CatalogRegion): number {
  return region === 'catalog.categories'
    ? config.CATALOG_CATEGORY_CACHE_TTL_SECONDS
    : config.CATALOG_ITEM_CACHE_TTL_SECONDS;
}
