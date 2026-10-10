import { config } from '../config';
import { directoryAdapter, unsupportedDirectoryAdapter } from '../integrations/directory';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { listAllOrganizationIds } from '../models';
import { logger } from '../utils/logger';
import { recordJobRun } from './metrics.service';
import { syncRoster } from './roster-sync.service';

/**
 * The roster sync scheduler (`docs/32` §6, `docs/03` §6).
 *
 * Reconciliation is **scheduled and single-leader**: every instance may start the scheduler
 * while a Redis lock elects one sweeper per tick, and each tenant is reconciled once. The run
 * itself is idempotent and resumable, so a duplicate tick is harmless — the lock only bounds
 * directory load and log volume.
 *
 * With no directory configured the scheduler is a **no-op** rather than a failing job: there is
 * nothing to reconcile, and a failure every interval would train operators to ignore it.
 */

const LOCK_KEY = redisKey('job', 'roster-sync', 'leader');
const LOCK_TTL_MS = 60_000;

export interface RosterSyncScheduler {
  stop: () => void;
}

export function startRosterSyncScheduler(
  intervalMs: number = config.ROSTER_SYNC_INTERVAL_MS,
): RosterSyncScheduler {
  if (directoryAdapter === unsupportedDirectoryAdapter) {
    return { stop: () => undefined };
  }

  const tick = async (): Promise<void> => {
    const acquired = await redisCommand(
      { operation: 'roster-sync-lock' },
      async (client) => (await client.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK',
    );

    const shouldRun = acquired === true || (acquired === null && !isRedisConfigured());
    if (!shouldRun) {
      return;
    }

    try {
      const organizations = await listAllOrganizationIds();
      for (const organization of organizations) {
        try {
          await syncRoster({ organizationId: organization.id, adapter: directoryAdapter });
        } catch (error) {
          // One tenant's failure must not stop the sweep or crash the process (`docs/32` §1).
          logger.error(
            { organizationId: organization.id, err: error },
            'Roster sync failed for a tenant',
          );
        }
      }
      recordJobRun('roster_sync', true);
    } catch (error) {
      recordJobRun('roster_sync', false);
      logger.error({ err: error }, 'Roster sync sweep failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
