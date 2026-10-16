import type { Server } from 'node:http';
// First, always: loads a local `backend/.env` (when one exists) **before** `./config`
// validates the environment at import time, so `npm start` and `npm run dev` work on a
// machine that has a `.env` rather than requiring every variable to be exported
// (`config/load-env.ts`). A real environment still wins.
import './config/load-env';
import { createApp } from './app';
import { config, processRole, runsSchedulers, servesHttp } from './config';
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
 * Process entrypoint (docs/03 §7, docs/35 §6).
 *
 * A backend instance is STATELESS: no local sessions, no local uploads, no local
 * caches, no local job locks. That is what makes the horizontal story true, and it is
 * also why graceful shutdown matters — during a rolling deploy the load balancer needs
 * this instance to finish in-flight requests before it disappears.
 */

// `docs/03` §3: the worker does not serve HTTP, and the API does not own the schedulers. A
// process configured as the worker tier must not start the HTTP listener; a process configured
// as the API tier starts only the listener. Refusing beats silently starting the wrong tier.
if (!servesHttp(processRole)) {
  logger.fatal(
    { PROCESS_ROLE: processRole },
    'The API entrypoint requires PROCESS_ROLE=api or all; start the worker entrypoint (dist/worker.js) for the worker tier.',
  );
  process.exit(1);
}

const app = createApp();

const server: Server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, PROCESS_ROLE: processRole },
    'ServiceHub API listening',
  );
});

// Provider delivery webhooks (`docs/29` N8) are dispatched by the inbound worker, so the
// handlers must be on the registry before its first tick. Registered only when this process
// runs schedulers: an API-role process runs no inbound worker, and registering there would
// be dead weight. Guarded, not conditional inside the array, so the two entrypoints stay
// symmetrical.
if (runsSchedulers(processRole)) {
  registerNotificationProviderHandlers();
}

/**
 * The background schedulers (`docs/03` §6, `docs/25` §6, `docs/29` §3, `docs/30` §3.4, `docs/32`).
 *
 * Each takes a short-lived Redis lock per tick, so every instance may start one while a single
 * leader sweeps per tick. They are started here only for `PROCESS_ROLE=all` — the honest
 * single-process developer default. An `api`-role deployment starts none of them: the worker
 * workload owns the queue, and N API instances each scheduling is exactly the defect `docs/03`
 * J5 names. The two entrypoints start the same seven, in the same order, so they cannot drift.
 */
const schedulers = runsSchedulers(processRole)
  ? [
      // The SLA breach/at-risk sweep (`docs/25` §6).
      startSlaSweepScheduler(),
      // The notifications outbox drain (`docs/29` §3).
      startNotificationScheduler(),
      // The async report export worker (`docs/30` §3.4).
      startReportExportScheduler(),
      // The outbound webhook worker (`docs/32` §4): fan out new events, then deliver what is
      // due. Delivery never happens on the request path.
      startWebhookScheduler(),
      // The inbound webhook processor (`docs/32` §5): receive is request-path and only verifies,
      // persists and acks; this worker validates and dispatches what was received.
      startInboundWebhookScheduler(),
      // The roster sync sweep (`docs/32` §6). A no-op unless a directory adapter is configured.
      startRosterSyncScheduler(),
      // The antivirus scan step (`docs/19` §7.2). A no-op unless a scanner is configured; it
      // is what promotes an uploaded attachment from PENDING to retrievable.
      startAttachmentScanScheduler(),
    ]
  : [];

/**
 * Graceful shutdown:
 *   1. stop accepting new connections (readiness will fail, so the LB drains us);
 *   2. let in-flight requests finish;
 *   3. release the database pool and the shared cache connection;
 *   4. exit.
 *
 * A hard timeout forces exit if a request is stuck, so a shutdown cannot hang forever
 * and block a deploy. A stuck request is a defect to be found in the logs, not a reason
 * to keep a dying instance in rotation.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received; draining connections');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  for (const scheduler of schedulers) scheduler.stop();

  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, 'Error while closing the HTTP server');
    }

    try {
      await disconnectDatabase();
    } catch (disconnectError) {
      logger.error({ err: disconnectError }, 'Error while closing the database pool');
    }

    try {
      await disconnectRedis();
    } catch (disconnectError) {
      logger.error({ err: disconnectError }, 'Error while closing the Redis connection');
    }

    clearTimeout(forceExit);
    logger.info('Shutdown complete');
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An unhandled rejection or uncaught exception leaves the process in an unknown state.
 * The safe response is to log it loudly and exit so the orchestrator replaces the
 * instance, rather than to keep serving requests from corrupt state.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException');
});
