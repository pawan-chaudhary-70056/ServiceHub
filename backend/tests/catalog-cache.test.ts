/**
 * Catalog cache regions — `docs/21` §10 (AC5), `docs/33` C1–C5/C8.
 *
 * These are unit tests of the cache contract itself, run against the in-process store
 * (no Redis in a bare test run), which has identical semantics to the shared tier
 * (`catalog-cache.ts`'s module docstring: two stores, one contract). What is asserted
 * here is the contract, not the transport:
 *
 *   - C1 — the viewer class is part of the key: two views never share an entry.
 *   - C2 — an entry expires at its explicit TTL; nothing is unbounded.
 *   - C3 — a mutation's invalidation makes the next read reload immediately.
 *   - C5 — keys carry the tenant: no entry crosses an organization boundary.
 *   - C8 — hit/miss/invalidation is measured per region.
 *
 * The Redis-backed path is covered by `redis.integration.test.ts`'s shared-client
 * helpers plus the catalog integration suite, which exercises read-through and
 * invalidation end to end against the API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateCatalogCache,
  readCatalogRegion,
  resetCatalogCache,
} from '../src/services/catalog-cache';
import { renderMetrics } from '../src/services/metrics.service';

interface ReadOptions {
  region?: 'catalog.categories' | 'catalog.items';
  organizationId?: string;
  viewKey?: string;
  ttlSeconds?: number;
  load: () => Promise<string>;
}

function read(options: ReadOptions): Promise<string> {
  return readCatalogRegion({
    region: options.region ?? 'catalog.items',
    organizationId: options.organizationId ?? 'org-tenant-a',
    viewKey: options.viewKey ?? 'manager|ACTIVE|ANY|20|FIRST',
    ttlSeconds: options.ttlSeconds ?? 60,
    load: options.load,
  });
}

beforeEach(() => {
  resetCatalogCache();
});

describe('readCatalogRegion', () => {
  it('serves the second read from the cache (C2: one load per TTL)', async () => {
    const load = vi.fn(async () => JSON.stringify({ items: ['laptop'] }));

    expect(await read({ load })).toBe(JSON.stringify({ items: ['laptop'] }));
    expect(await read({ load })).toBe(JSON.stringify({ items: ['laptop'] }));

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps two viewer classes in two entries (C1: never one shared filtered view)', async () => {
    const managerLoad = vi.fn(async () => JSON.stringify({ items: ['draft-laptop'] }));
    const requesterLoad = vi.fn(async () => JSON.stringify({ items: ['active-laptop'] }));

    await read({ viewKey: 'manager|DRAFT|ANY|20|FIRST', load: managerLoad });
    const requesterPayload = await read({
      viewKey: 'requester|ACTIVE|ANY|20|FIRST',
      load: requesterLoad,
    });

    // The requester's read was its own load, not the manager's cached rows.
    expect(requesterLoad).toHaveBeenCalledTimes(1);
    expect(requesterPayload).toBe(JSON.stringify({ items: ['active-laptop'] }));

    // And a repeat of either view is still a hit on its own entry.
    await read({ viewKey: 'manager|DRAFT|ANY|20|FIRST', load: managerLoad });
    expect(managerLoad).toHaveBeenCalledTimes(1);
  });

  it('never shares an entry across tenants (C5: the key carries the organization)', async () => {
    const loadA = vi.fn(async () => JSON.stringify({ items: ['org-a-item'] }));
    const loadB = vi.fn(async () => JSON.stringify({ items: ['org-b-item'] }));

    const first = await read({ organizationId: 'org-a', load: loadA });
    const second = await read({ organizationId: 'org-b', load: loadB });

    expect(first).toBe(JSON.stringify({ items: ['org-a-item'] }));
    expect(second).toBe(JSON.stringify({ items: ['org-b-item'] }));
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
  });

  it('expires an entry at its TTL (C2: no unbounded entry)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
      const load = vi.fn(async () => 'payload');

      await read({ ttlSeconds: 10, load });
      await read({ ttlSeconds: 10, load });
      expect(load).toHaveBeenCalledTimes(1);

      // Jitter is ±10 % of the TTL, so 60 s is past any jittered 10 s expiry.
      vi.setSystemTime(new Date('2026-10-15T12:01:00Z'));
      await read({ ttlSeconds: 10, load });
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a failing load (C4: a failed read is not an entry)', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValueOnce('recovered');

    await expect(read({ load })).rejects.toThrow('database down');
    expect(await read({ load })).toBe('recovered');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('moves both regions together — one invariant cannot be half-right', async () => {
    const categoryLoad = vi.fn(async () => 'tree');
    const itemLoad = vi.fn(async () => 'items');

    await read({ region: 'catalog.categories', viewKey: 'tree', load: categoryLoad });
    await read({ region: 'catalog.items', load: itemLoad });

    // An item activation changes the per-category counts in the tree; a category rename
    // changes the `categoryName` denormalised into list rows. So any catalog mutation
    // bumps both generations rather than trying to decide which half moved.
    await invalidateCatalogCache('org-tenant-a');

    await read({ region: 'catalog.items', load: itemLoad });
    await read({ region: 'catalog.categories', viewKey: 'tree', load: categoryLoad });

    expect(itemLoad).toHaveBeenCalledTimes(2);
    expect(categoryLoad).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the tenant whose data moved (C5)', async () => {
    const loadA = vi.fn(async () => 'a');
    const loadB = vi.fn(async () => 'b');

    await read({ organizationId: 'org-a', load: loadA });
    await read({ organizationId: 'org-b', load: loadB });

    await invalidateCatalogCache('org-a');

    await read({ organizationId: 'org-b', load: loadB });
    expect(loadB).toHaveBeenCalledTimes(1); // org-b's entries are still warm

    await read({ organizationId: 'org-a', load: loadA });
    expect(loadA).toHaveBeenCalledTimes(2); // org-a reloaded
  });
});

describe('invalidateCatalogCache', () => {
  it('makes the next read reload — the mutation is visible at once (C3)', async () => {
    const load = vi.fn(async () => JSON.stringify({ items: [] }));
    await read({ load });
    expect(load).toHaveBeenCalledTimes(1);

    // A catalog mutation commits, then invalidates.
    await invalidateCatalogCache('org-tenant-a');

    const afterWrite = vi.fn(async () => JSON.stringify({ items: ['new-item'] }));
    expect(await read({ load: afterWrite })).toBe(JSON.stringify({ items: ['new-item'] }));
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('does not throw with no shared tier configured (C4: cache outage is a miss)', async () => {
    await expect(invalidateCatalogCache('org-tenant-a')).resolves.toBeUndefined();
  });

  it('records hit, miss and invalidation per region (C8)', async () => {
    const load = vi.fn(async () => 'payload');
    await read({ load }); // miss
    await read({ load }); // hit
    await invalidateCatalogCache('org-tenant-a');

    const metrics = renderMetrics();
    expect(metrics).toMatch(
      /servicehub_cache_operations_total\{region="catalog\.items",outcome="miss"\} [1-9]\d*/,
    );
    expect(metrics).toMatch(
      /servicehub_cache_operations_total\{region="catalog\.items",outcome="hit"\} [1-9]\d*/,
    );
    expect(metrics).toMatch(
      /servicehub_cache_operations_total\{region="catalog\.items",outcome="invalidation"\} [1-9]\d*/,
    );
    expect(metrics).toMatch(
      /servicehub_cache_operations_total\{region="catalog\.categories",outcome="invalidation"\} [1-9]\d*/,
    );
  });
});
