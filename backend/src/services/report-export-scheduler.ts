import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { logger } from '../utils/logger';
import { recordJobRun } from './metrics.service';
import { processQueuedExports } from './report-export.service';

/**
 * The report export runner (`docs/30` §3.4, `docs/03` §6).
 *
 * Same leadership model as the other workers: a short-lived Redis lock per tick, so every
 * instance may start it while one processes the queue. With Redis absent it runs locally.
 */

const LOCK_KEY = redisKey('job', 'report-export', 'leader');
const LOCK_TTL_MS = 10_000;

export interface ReportExportScheduler {
  stop: () => void;
}

export function startReportExportScheduler(
  intervalMs: number = config.REPORT_EXPORT_INTERVAL_MS,
): ReportExportScheduler {
  const tick = async (): Promise<void> => {
    const acquired = await redisCommand(
      { operation: 'report-export-lock' },
      async (client) => (await client.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK',
    );

    const shouldRun = acquired === true || (acquired === null && !isRedisConfigured());
    if (!shouldRun) {
      return;
    }

    try {
      await processQueuedExports();
      recordJobRun('report_export', true);
    } catch (error) {
      // Export processing is off the request path; a failure must never crash the process.
      recordJobRun('report_export', false);
      logger.error({ err: error }, 'Report export processing failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
