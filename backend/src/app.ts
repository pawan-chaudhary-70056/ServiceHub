import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { API_PREFIX, config, isTest } from './config';
import { correlationId } from './middlewares/correlation';
import { errorHandler } from './middlewares/error-handler';
import { metricsMiddleware } from './middlewares/metrics';
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

  // Request metrics (docs/34 §4): registered before the routes and flushed on each
  // response's `finish`, so the measurement spans the whole pipeline. The label is the
  // matched route pattern, never the concrete URL (`34` §4.2).
  app.use(metricsMiddleware);

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

  // Pinned, not defaulted (docs/17 §5): a default set is whatever the library's next
  // release decides it is. Every directive the security architecture requires is stated
  // here so a dependency bump cannot silently relax it — `default-src 'self'`, no
  // `unsafe-inline` for scripts, no framing, HSTS for a year.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'base-uri': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'script-src': ["'self'"],
          // The API returns JSON, but a stylesheet or inline style in an error page is
          // still an injection surface; styles are allowed, scripts never are.
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'upgrade-insecure-requests': [],
        },
      },
      strictTransportSecurity: {
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: false,
      },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      // COEP would require CORP on every cross-origin fetch the browser makes; the API
      // and the SPA are same-origin in production, so it buys nothing and breaks the
      // dev origin pairing.
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      frameguard: { action: 'deny' },
      noSniff: true,
      xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
  );

  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      // Required by `ADR-0001`: cookie-based sessions need credentialed CORS.
      credentials: true,
    }),
  );

  app.use(
    express.json({
      limit: '1mb',
      // Keep the exact bytes a peer sent. A webhook signature is computed over the raw body,
      // and re-serialising the parsed object can differ in key order and break verification
      // (docs/32 §5). The buffer is bounded by `limit` and is never logged wholesale.
      verify: (req, _res, buffer) => {
        (req as { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Probes are mounted before the limiter so they cannot be throttled into a false
  // outage (docs/34 §6).
  app.use(`${API_PREFIX}/health`, probeRouter);

  // Application-layer rate limiting. Counters live in the shared Redis store, so the limit
  // holds across instances rather than multiplying by the instance count; the in-memory
  // store is used only when Redis is unconfigured, which is a local/test case (docs/33 §6,
  // `ADR-0003` — see rate-limit.ts for the degradation and failure policy).
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
