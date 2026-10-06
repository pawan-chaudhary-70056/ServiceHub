import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { parseCookies } from '../helpers/cookies';
import { resolveSession } from '../services';
import { UnauthenticatedError } from '../utils/errors';

/**
 * Authentication middleware (`ADR-0001`, docs/06 §2, docs/04 §3 step 3).
 *
 * Resolves the caller from the `HttpOnly` session cookie and attaches the identity plus
 * its effective permission set to the request. The session token is never read from a
 * header or the body: a cookie-authenticated API has exactly one source of identity.
 *
 * The middleware answers only "who is calling". It deliberately does not decide what the
 * caller may do — that is the route's coarse check (`requirePermission`) followed by the
 * authoritative service check (docs/07 §6). Every route below the API router that is not
 * explicitly public must run this.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    const cookies = parseCookies(req.header('cookie'));
    const token = cookies[config.SESSION_COOKIE_NAME];

    if (!token) {
      throw new UnauthenticatedError();
    }

    const resolved = await resolveSession(token);
    if (!resolved) {
      // Expired, revoked, or belonging to a deactivated user — all the same to a caller.
      throw new UnauthenticatedError();
    }

    req.actor = resolved.actor;
    req.session = { id: resolved.sessionId, csrfSecretHash: resolved.csrfSecretHash };
    next();
  })().catch(next);
}
