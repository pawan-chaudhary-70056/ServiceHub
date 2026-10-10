import { config } from '../config';
import { isRedisConfigured, redisCommand, redisKey } from '../integrations/redis';
import { logger } from '../utils/logger';
import { recordJobRun } from './metrics.service';
import { processInboundWebhookEvents } from './inbound-webhook.service';

/**
 * The inbound webhook worker (`docs/32` §5, `docs/03` §6).
 *
 * Receive is request-path and does nothing but verify, persist and ack; **this** is where a
 * provider's event is validated and dispatched. Single-leader per tick via a Redis lock, like
 * the other workers; the work is idempotent regardless because a processed event is marked
 * and a retryable one is retried by status.
 */

const LOCK_KEY = redisKey('job', 'inbound-webhooks', 'leader');
const LOCK_TTL_MS = 20_000;

export interface InboundWebhookScheduler {
  stop: () => void;
}

export function startInboundWebhookScheduler(
  intervalMs: number = config.INBOUND_WEBHOOK_INTERVAL_MS,
): InboundWebhookScheduler {
  const tick = async (): Promise<void> => {
    const acquired = await redisCommand(
      { operation: 'inbound-webhooks-lock' },
      async (client) => (await client.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK',
    );

    const shouldRun = acquired === true || (acquired === null && !isRedisConfigured());
    if (!shouldRun) {
      return;
    }

    try {
      await processInboundWebhookEvents();
      recordJobRun('inbound_webhook', true);
    } catch (error) {
      // A malformed or hostile event must never crash the process (`docs/32` §9).
      recordJobRun('inbound_webhook', false);
      logger.error({ err: error }, 'Inbound webhook processing failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
