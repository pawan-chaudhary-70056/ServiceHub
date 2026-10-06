import type { NextFunction, Request, Response } from 'express';
import { checkReadiness } from '../services';
import { AppError } from '../utils/errors';

/**
 * Health and probe endpoints (docs/34 §6).
 *
 * Controllers do HTTP translation only — parse, call a service, shape the response
 * (docs/03 §3). They contain no business logic and never touch the database directly;
 * the ESLint boundary rules enforce the latter.
 */

/**
 * Liveness — "is this process alive and not deadlocked?"
 *
 * Deliberately does NOT check the database. If liveness depended on the database, a
 * brief database blip would cause the orchestrator to restart every instance at once,
 * converting a degradation into an outage (docs/34 §6).
 */
export function live(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok' });
}

/**
 * Readiness — "can this instance serve traffic now?"
 *
 * Checks the database with a cheap query. Returning 503 removes this instance from the
 * load-balancer pool; it is drained, not restarted, and the other instances keep
 * serving (docs/03 §8).
 */
export async function ready(_req: Request, res: Response): Promise<void> {
  const report = await checkReadiness();

  if (!report.ready) {
    throw new AppError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service is not ready to accept traffic.',
    });
  }

  res.status(200).json({ status: 'ready', checks: report.checks });
}

/**
 * Dependency detail for humans and alerting.
 *
 * Always 200: it reports state rather than asserting it, so a monitoring system can
 * distinguish "this instance is not ready" from "this endpoint is broken". Internal
 * only — it should not be reachable from the public internet.
 */
export async function deps(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const report = await checkReadiness();
    res.status(200).json({ ready: report.ready, checks: report.checks });
  } catch (error) {
    next(error);
  }
}
