import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { logger } from '../utils/logger';
import { recordJobRun } from './metrics.service';
import { deliverPendingWebhooks, fanoutWebhooks } from './webhook.service';

/**
 * The webhook worker (`docs/32` §4, `docs/03` §6).
 *
 * Each tick fans out new outbox events into deliveries, then delivers what is due. The same
 * single-leader Redis lock as the other workers means every instance may start it while one
 * runs per tick; the fan-out cursor and the `(subscriptionId, eventId)` unique key make the
 * work idempotent regardless.
 *
 * Delivery is off the request path by construction (`docs/32` §1): the scheduler is the only
 * thing that ever calls a subscriber's endpoint.
 */

const LOCK_KEY = redisKey('job', 'webhooks', 'leader');
const LOCK_TTL_MS = 20_000;

export interface WebhookScheduler {
  stop: () => void;
}

export function startWebhookScheduler(
  intervalMs: number = config.WEBHOOK_DELIVERY_INTERVAL_MS,
): WebhookScheduler {
  const tick = async (): Promise<void> => {
    const acquired = await redisCommand(
      { operation: 'webhooks-lock' },
      async (client) => (await client.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK',
    );

    const shouldRun = acquired === true || (acquired === null && !isRedisConfigured());
    if (!shouldRun) {
      return;
    }

    try {
      await fanoutWebhooks();
      await deliverPendingWebhooks();
      // "Queue depth / dead letters growing" (`docs/34` §7.2) is answered from the job
      // timestamps plus the per-integration bulkhead gauges.
      recordJobRun('webhook_delivery', true);
    } catch (error) {
      // An integration failure must never crash the process (`docs/32` §9): log and retry.
      recordJobRun('webhook_delivery', false);
      logger.error({ err: error }, 'Webhook processing failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
