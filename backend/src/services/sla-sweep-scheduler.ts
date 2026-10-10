import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { logger } from '../utils/logger';
import { recordJobRun } from './metrics.service';
import { runSlaSweep } from './sla-sweep.service';

/**
 * The SLA sweep runner (`docs/25` §6, `docs/03` §6).
 *
 * **Exactly one runner must sweep.** N instances each running it produce duplicate breach
 * events, so leadership is a short-lived Redis lock taken per tick: whichever instance
 * wins the tick runs the sweep. The lock TTL is shorter than the interval, so a crash
 * releases leadership within one cycle rather than freezing the sweep indefinitely.
 *
 * When Redis is unconfigured (local development, single instance), the sweep runs
 * locally — there is no second instance to duplicate against.
 */

const LOCK_KEY = redisKey('job', 'sla-sweep', 'leader');
/** Shorter than the interval so a dead leader's lock expires before the next tick. */
const LOCK_TTL_MS = 30_000;

export interface SlaSweepScheduler {
  stop: () => void;
}

export function startSlaSweepScheduler(
  intervalMs: number = config.SLA_SWEEP_INTERVAL_MS,
): SlaSweepScheduler {
  const tick = async (): Promise<void> => {
    const acquired = await redisCommand(
      { operation: 'sla-sweep-lock' },
      async (client) => (await client.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK',
    );

    // `null` means either Redis is absent (run locally) or the command failed (skip, to
    // avoid duplicate sweeps across instances during a Redis blip).
    const shouldRun = acquired === true || (acquired === null && !isRedisConfigured());
    if (!shouldRun) {
      return;
    }

    try {
      await runSlaSweep();
      // "SLA sweep stalled" is a page-level alert (docs/34 §7): a sweep that silently
      // stops breaching clocks looks healthy everywhere else (`docs/25` §6).
      recordJobRun('sla_sweep', true);
    } catch (error) {
      // The sweep is not on the request path; a failure here must never crash the process.
      recordJobRun('sla_sweep', false);
      logger.error({ err: error }, 'SLA sweep run failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the event loop open on account of the sweep.
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
