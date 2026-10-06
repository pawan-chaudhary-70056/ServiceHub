import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../utils/errors';

/**
 * Unmatched routes become a NOT_FOUND problem response, not Express's HTML default.
 *
 * A consistent error shape matters more than a pretty 404: a client that has to parse
 * an HTML page to detect a missing route will get it wrong.
 */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`No route matches ${req.method} ${req.path}.`));
}
