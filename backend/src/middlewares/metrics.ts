import type { NextFunction, Request, Response } from 'express';
import { recordRequest } from '../services/metrics.service';

/**
 * Request metrics (docs/34 §4.1, RED signals).
 *
 * One `finish` listener per response, so the measurement covers everything the request
 * touched — middleware, controller, service, query — rather than only the handler. The
 * label is the **route pattern** Express matched (`/requests/:id`), never the concrete
 * URL: a per-record label is both a cardinality explosion and a way for record ids to
 * leak into a monitoring system (`34` §4.2, `19` §1).
 *
 * An unmatched path has no pattern, so it is recorded as `unmatched` — a scanner walking
 * random URLs must not create a time series per URL either.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    recordRequest(req.method, routePattern(req), res.statusCode, durationSeconds);
  });

  next();
}

/** The matched route pattern, or `unmatched` when nothing matched. */
function routePattern(req: Request): string {
  const route = (req as { route?: { path?: string } }).route;
  if (!route?.path) {
    return 'unmatched';
  }
  // `baseUrl` carries the mount prefix (`/api/v1/requests`), the route path the rest
  // (`/:id`), so the label is the full pattern a dashboard can link to a document.
  return `${req.baseUrl}${route.path === '/' ? '' : route.path}`;
}
