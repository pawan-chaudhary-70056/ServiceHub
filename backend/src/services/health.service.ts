import { config } from '../config';
import { pingRedis } from '../integrations/redis';
import { pingDatabase } from '../models';

/**
 * Readiness (docs/34 §6).
 *
 * The distinction this service implements is the one that matters operationally:
 *
 *   - LIVENESS asks "is the process alive and not deadlocked?" and must NOT check the
 *     database. If it does, a brief database wobble restarts every instance at once and
 *     turns a degradation into an outage.
 *   - READINESS asks "can this instance serve traffic now?" and therefore does check
 *     the database, with a cheap query. Failing readiness removes the instance from the
 *     load-balancer pool without restarting it.
 *
 * The cache/queue tier (Redis, `ADR-0003`) is deliberately NOT part of readiness: it
 * is best-effort by design, so an instance remains able to serve with it down
 * (docs/33 C4, docs/34 §6).
 */

export interface DependencyStatus {
  name: string;
  status: 'up' | 'down' | 'not_configured';
  detail?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: DependencyStatus[];
}

export async function checkReadiness(): Promise<ReadinessReport> {
  const databaseUp = await pingDatabase();

  // Redis is reported for information but never gates readiness: it is best-effort by
  // design (`docs/33` C4), so a cache outage must not drain every instance (docs/34 §6).
  let cacheStatus: DependencyStatus['status'] = 'not_configured';
  let cacheDetail: string | undefined =
    'Redis is not configured; degrading to database reads (ADR-0003).';
  if (config.REDIS_URL) {
    const cacheUp = await pingRedis();
    cacheStatus = cacheUp ? 'up' : 'down';
    cacheDetail = cacheUp
      ? undefined
      : 'Redis is unreachable; degrading to the database (docs/33 C4).';
  }

  const checks: DependencyStatus[] = [
    {
      name: 'database',
      status: databaseUp ? 'up' : 'down',
    },
    {
      name: 'cache_queue',
      status: cacheStatus,
      detail: cacheDetail,
    },
  ];

  return {
    ready: databaseUp,
    checks,
  };
}
