import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { hasAnyPermission, hasPermission } from '../helpers/authorization';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors';

/**
 * Coarse, route-level permission check (docs/07 §6).
 *
 * This is the fast rejection layer: it stops a request whose caller plainly lacks the
 * permission before any parsing, query or business logic runs. It is **necessary and
 * insufficient** — docs/07 §1 is explicit that a role check without the scope and object
 * checks is the dominant real-world failure (IDOR). The authoritative check is in the
 * service, on the resolved object.
 *
 * `authenticate` must precede this on the route; if no actor is present the request is
 * unauthenticated, not forbidden.
 */
export function requirePermission(permission: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      next(new UnauthenticatedError());
      return;
    }

    if (!hasPermission(req.actor, permission)) {
      next(new ForbiddenError());
      return;
    }

    next();
  };
}

/**
 * Coarse route check for a capability expressed as several scoped grants.
 *
 * Reads are the common case: `request:read.own | .team | .any` are three grants for one
 * capability, and a reader holds exactly the scope they were given (`07` §3). The
 * service still re-checks and applies the object-level rule.
 */
export function requireAnyPermission(permissions: readonly string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      next(new UnauthenticatedError());
      return;
    }

    if (!hasAnyPermission(req.actor, permissions)) {
      next(new ForbiddenError());
      return;
    }

    next();
  };
}
