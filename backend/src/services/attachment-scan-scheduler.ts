import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { logger } from '../utils/logger';
import { scanPendingAttachments } from './attachment-scan.service';
import { recordJobRun } from './metrics.service';

/**
 * The antivirus scan worker (`docs/19` §7.2 step 7, `docs/03` §6).
 *
 * Single-leader per tick via a Redis lock, like every other worker, so running this process
 * N times does not scan the same file N times. The work is idempotent regardless: a row is
 * claimed by status, and re-scanning an `AVAILABLE` row is not possible because it is no
 * longer listed as `PENDING`.
 *
 * The tick never throws: a scanner that is down must not crash the process that is supposed
 * to be recovering from it (`docs/32` §9).
 */

const LOCK_KEY = redisKey('job', 'attachment-scan', 'leader');
const LOCK_TTL_MS = 20_000;

export interface AttachmentScanScheduler {
  stop: () => void;
}

export function startAttachmentScanScheduler(
  intervalMs: number = config.ANTIVIRUS_INTERVAL_MS,
): AttachmentScanScheduler {
  const tick = async (): Promise<void> => {
    const acquired = await redisCommand(
      { operation: 'attachment-scan-lock' },
      async (client) => (await client.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK',
    );

    const shouldRun = acquired === true || (acquired === null && !isRedisConfigured());
    if (!shouldRun) {
      return;
    }

    try {
      const result = await scanPendingAttachments();
      // `success` reflects the run, not the verdicts: quarantining a file is a job that
      // worked, and reporting it as a failure would alert on exactly the control doing its job.
      recordJobRun('attachment_scan', true);
      if (result.quarantined > 0 || result.deferred > 0 || result.unreadable > 0) {
        logger.info(result, 'Attachment scan tick completed with attention needed');
      }
    } catch (error) {
      recordJobRun('attachment_scan', false);
      logger.error({ err: error }, 'Attachment scan failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
