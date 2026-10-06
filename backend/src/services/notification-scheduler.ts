import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { logger } from '../utils/logger';
import { drainOutbox } from './notification.service';

/**
 * The notifications drain runner (`docs/29` §3, `docs/03` §6).
 *
 * The same leadership model as the SLA sweep: a short-lived Redis lock taken per tick, so
 * every instance may start the scheduler while exactly one drains per tick. The drain is
 * idempotent anyway, but a single leader keeps provider calls and log volume bounded.
 *
 * When Redis is unconfigured (local, single instance) the drain runs locally.
 */

const LOCK_KEY = redisKey('job', 'notifications-drain', 'leader');
/** Shorter than the interval so a dead leader's lock expires before the next tick. */
const LOCK_TTL_MS = 20_000;

export interface NotificationScheduler {
  stop: () => void;
}

export function startNotificationScheduler(
  intervalMs: number = config.NOTIFICATION_DRAIN_INTERVAL_MS,
): NotificationScheduler {
  const tick = async (): Promise<void> => {
    const acquired = await redisCommand(
      { operation: 'notifications-drain-lock' },
      async (client) => (await client.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK',
    );

    const shouldRun = acquired === true || (acquired === null && !isRedisConfigured());
    if (!shouldRun) {
      return;
    }

    try {
      await drainOutbox();
    } catch (error) {
      // Delivery is off the request path; a failure here must never crash the process.
      logger.error({ err: error }, 'Notification drain failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
