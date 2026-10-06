import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { API_PREFIX, config, isTest } from './config';
import { correlationId } from './middlewares/correlation';
import { errorHandler } from './middlewares/error-handler';
import { notFound } from './middlewares/not-found';
import { createRateLimiter } from './middlewares/rate-limit';
import { apiRouter, probeRouter } from './routes';
import { logger } from './utils/logger';

/**
 * Application assembly.
 *
 * The middleware order below is the request pipeline described in docs/03 §5, and the
 * order is load-bearing:
 *
 *   1. correlation id first — everything after it can log a findable identifier;
 *   2. request logging — so a request appears even if a later middleware throws;
 *   3. security headers and CORS — cheap, and they must apply to error responses too;
 *   4. body parsing with a size bound — an unbounded body is a memory exhaustion path;
 *   5. probes, unthrottled;
 *   6. rate limiting, then the domain API;
 *   7. not-found, then the error handler — the error handler must be last, because
 *      Express only routes errors to middleware registered after the failing one.
 *
 * Body parsing is deliberately bounded (`1mb`). File uploads do not come through here:
 * they use a dedicated, content-validated, size-capped path (docs/19).
 */
export function createApp(): Express {
  const app = express();

  // Do not advertise the framework — it narrows an attacker's search (docs/17).
  app.disable('x-powered-by');

  // Only trust proxy headers when actually behind a known proxy; otherwise a client
  // can spoof its own IP into rate limiting and the audit trail (docs/17).
  if (config.TRUST_PROXY) {
    app.set('trust proxy', 1);
  }

  app.use(correlationId);

  app.use(
    pinoHttp({
      logger,
      enabled: !isTest,
      genReqId: (req) => (req as { correlationId?: string }).correlationId ?? '',
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // Never log bodies or headers wholesale: they carry credentials and PII (docs/34 L1).
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet());

  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      // Required by `ADR-0001`: cookie-based sessions need credentialed CORS.
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Probes are mounted before the limiter so they cannot be throttled into a false
  // outage (docs/34 §6).
  app.use(`${API_PREFIX}/health`, probeRouter);

  // Application-layer rate limiting. NOTE: this scaffold implementation counts in
  // process memory, so limits multiply across instances — it must move to the Redis
  // store chosen by `ADR-0003` before production (docs/33 §6, see rate-limit.ts).
  app.use(
    API_PREFIX,
    createRateLimiter({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      max: config.RATE_LIMIT_MAX,
    }),
    apiRouter,
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
