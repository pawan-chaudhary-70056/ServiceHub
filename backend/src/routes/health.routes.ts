import { Router } from 'express';
import { deps, live, metrics, ready } from '../controllers/health.controller';

/**
 * Probe routes.
 *
 * These are mounted WITHOUT the rate limiter: a probe that gets rate limited reports a
 * false outage, and probes are infrastructure traffic rather than user traffic.
 * Access is restricted at the edge — these are never publicly routed (docs/34 §6).
 *
 * Routes contain no logic beyond mapping a path to a controller (docs/03 §3).
 */
export const healthRouter = Router();

healthRouter.get('/live', live);
healthRouter.get('/ready', ready);
healthRouter.get('/deps', deps);
// Prometheus text exposition (`docs/34` §4). Internal only, like the other probes.
healthRouter.get('/metrics', metrics);
