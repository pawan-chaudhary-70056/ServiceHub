import type { NextFunction, Request, Response } from 'express';
import { safeEqual, sha256 } from '../helpers/crypto';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors';

/**
 * CSRF protection for cookie-authenticated state-changing requests
 * (`ADR-0001`, docs/06 §2 property 7, docs/11 §8).
 *
 * The pattern is double-submit: the server issues a random CSRF token in a readable
 * cookie and stores its digest on the session. A state-changing request must echo the
 * cookie value in `X-CSRF-Token`, and the server compares the digest of the header to
 * the digest on the session. An attacker who can force a cross-site request cannot read
 * the cookie (it is same-origin) and cannot set the custom header, so the request fails.
 *
 * Safe methods (GET/HEAD/OPTIONS) are exempt: they must not change state by contract, so
 * requiring a token on a page load would only break normal navigation.
 *
 * This runs AFTER `authenticate`, because it needs the session's stored digest.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  if (!req.actor || !req.session) {
    next(new UnauthenticatedError());
    return;
  }

  const header = req.header('x-csrf-token');
  const expected = req.session.csrfSecretHash;

  // No stored digest means the session predates CSRF protection or is malformed; fail
  // closed rather than allowing an unprotected state change.
  if (!header || !expected || !safeEqual(sha256(header), expected)) {
    next(new ForbiddenError('Missing or invalid CSRF token.'));
    return;
  }

  next();
}
