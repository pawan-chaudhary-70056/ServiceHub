import type { Server } from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { disconnectRedis } from './integrations/redis';
import { disconnectDatabase } from './models';
import {
  startNotificationScheduler,
  startReportExportScheduler,
  startSlaSweepScheduler,
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

const app = createApp();

const server: Server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'ServiceHub API listening');
});

// The SLA breach/at-risk sweep (`docs/25` §6). Leadership is a Redis lock, so every
// instance may start the scheduler and exactly one sweeps per tick.
const slaSweep = startSlaSweepScheduler();

// The notifications outbox drain (`docs/29` §3). Same leadership model: every instance
// may start it, and the Redis lock elects one drainer per tick.
const notifications = startNotificationScheduler();

// The async report export worker (`docs/30` §3.4). Same single-leader model.
const reportExports = startReportExportScheduler();

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

  slaSweep.stop();
  notifications.stop();
  reportExports.stop();

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
