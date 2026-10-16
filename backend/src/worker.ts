// First, always: loads a local `backend/.env` (when one exists) **before** `./config`
// validates the environment at import time. Without it `npm run start:worker` fails at boot
// with "DATABASE_URL: Required" on a machine that has a perfectly good `.env`. A real
// environment still wins — the file only fills values that are absent (`config/load-env.ts`).
import './config/load-env';
import { processRole, runsSchedulers, servesHttp } from './config';
import { disconnectRedis } from './integrations/redis';
import { disconnectDatabase } from './models';
import {
  registerNotificationProviderHandlers,
  startAttachmentScanScheduler,
  startInboundWebhookScheduler,
  startNotificationScheduler,
  startReportExportScheduler,
  startRosterSyncScheduler,
  startSlaSweepScheduler,
  startWebhookScheduler,
} from './services';
import { logger } from './utils/logger';

/**
 * Worker process entrypoint (`docs/03` §6/§7, `docs/34` §4).
 *
 * The asynchronous tier as its own workload. It runs **the schedulers and nothing else** — no
 * HTTP listener at all, because `docs/03` §3 says a worker must not serve HTTP. That is not
 * pedantry: a worker that answers requests is a second, differently-configured API surface
 * that no probe, CORS policy or rate limiter was designed for.
 *
 * Why a separate process rather than the in-process schedulers `server.ts` starts:
 *
 *   - **Scaling is independent.** API instances scale with request load; the worker scales with
 *     queue depth. Running both in one process means scaling one to fix the other (`docs/33` §1,
 *     "scale by measurement").
 *   - **A stuck job cannot take the API down**, and a deploy of the API does not restart the
 *     workers mid-job.
 *   - The leadership model is unchanged: each scheduler still takes its short-lived Redis lock
 *     per tick, so running this process N times is safe and exactly one sweeper runs per tick.
 *
 * `PROCESS_ROLE=all` starts the same schedulers from `server.ts` for a single-process
 * developer box; this entrypoint refuses that role, because starting both would mean two
 * processes each scheduling.
 */

if (servesHttp(processRole)) {
  // Refuse rather than start a second scheduler set. `docs/03` J5: N schedulers per interval
  // is the classic defect, and it is hidden by the lock until the lock has a bad day.
  logger.fatal(
    { PROCESS_ROLE: processRole },
    'The worker entrypoint requires PROCESS_ROLE=worker; the API tier runs the schedulers only when PROCESS_ROLE=all.',
  );
  process.exit(1);
}

if (!runsSchedulers(processRole)) {
  logger.fatal({ PROCESS_ROLE: processRole }, 'This process role does not run schedulers.');
  process.exit(1);
}

logger.info({ PROCESS_ROLE: processRole }, 'ServiceHub worker starting');

// Provider delivery webhooks (`docs/29` N8) are dispatched by the inbound worker below, so
// the handlers must exist before its first tick. Registration is explicit here because the
// registry is consulted only by the process that runs that worker.
registerNotificationProviderHandlers();

// The same seven schedulers `server.ts` starts, in one place so the two entrypoints cannot drift.
const schedulers = [
  startSlaSweepScheduler(),
  startNotificationScheduler(),
  startReportExportScheduler(),
  startWebhookScheduler(),
  startInboundWebhookScheduler(),
  startRosterSyncScheduler(),
  // The antivirus scan step (`docs/19` §7.2). A no-op unless a scanner is configured; it is
  // what promotes an uploaded attachment from PENDING to retrievable.
  startAttachmentScanScheduler(),
];

/**
 * Graceful shutdown (`docs/34` §6, `docs/35` §6).
 *
 * A worker's in-flight tick is not a request, so there is nothing to drain for the load
 * balancer; what matters is that the Redis leadership locks are released by expiry and the
 * database and cache connections close cleanly rather than being killed mid-statement.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutdown signal received; stopping schedulers');

  const forceExit = setTimeout(() => {
    logger.error('Worker shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  for (const scheduler of schedulers) scheduler.stop();

  try {
    await disconnectDatabase();
  } catch (error) {
    logger.error({ err: error }, 'Error while closing the database pool');
  }

  try {
    await disconnectRedis();
  } catch (error) {
    logger.error({ err: error }, 'Error while closing the Redis connection');
  }

  clearTimeout(forceExit);
  logger.info('Worker shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in the worker');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception in the worker');
  void shutdown('uncaughtException');
});
