import type { Request, Response } from 'express';
import {
  acceptInvitation,
  getIdentity,
  login,
  logout,
  requestPasswordReset,
  resetPassword,
} from '../services';
import { clearedSessionCookieHeaders, sessionCookieHeaders } from '../helpers/session-cookies';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  AcceptInvitationInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
} from '../validators/auth.validators';
import { requestMeta } from './support';

/**
 * Authentication endpoints (docs/11 §9, docs/06).
 *
 * Controllers do HTTP translation only: read validated input, call a service, shape the
 * response and set cookies. No credential is ever read from `req` here beyond the parsed
 * schema, and no token or hash is ever placed in a response body — session material
 * travels in `HttpOnly` cookies only (`ADR-0001`).
 */

/** `POST /auth/login` — issues a session and sets the session + CSRF cookies. */
export async function postLogin(req: Request, res: Response): Promise<void> {
  const { body } = validated<LoginInput>(res);
  const session = await login(body, requestMeta(req));

  res.setHeader('Set-Cookie', sessionCookieHeaders(session));
  res.status(200).json({ user: session.user, permissions: session.permissions });
}

/** `POST /auth/logout` — server-side revocation, then clear the cookies. */
export async function postLogout(req: Request, res: Response): Promise<void> {
  if (!req.actor || !req.session) {
    throw new UnauthenticatedError();
  }

  await logout(req.session.id, req.actor, requestMeta(req));
  res.setHeader('Set-Cookie', clearedSessionCookieHeaders());
  res.status(204).end();
}

/** `GET /auth/me` — the current identity plus its live effective permissions. */
export async function getMe(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }

  const identity = await getIdentity(req.actor.userId);
  if (!identity) {
    throw new UnauthenticatedError();
  }

  res.status(200).json({
    user: identity,
    permissions: [...req.actor.permissions].sort(),
  });
}

/**
 * `POST /auth/forgot` — always `202`, whether or not the address exists (docs/06 §5).
 * A different status for an unknown address would confirm account existence.
 */
export async function postForgotPassword(req: Request, res: Response): Promise<void> {
  const { body } = validated<ForgotPasswordInput>(res);
  await requestPasswordReset(body, requestMeta(req));
  res.status(202).json({ status: 'accepted' });
}

/** `POST /auth/reset` — consumes a single-use token and revokes existing sessions. */
export async function postResetPassword(req: Request, res: Response): Promise<void> {
  const { body } = validated<ResetPasswordInput>(res);
  await resetPassword(body, requestMeta(req));
  res.status(204).end();
}

/** `POST /auth/accept-invitation` — establishes the first credential (docs/06 §11). */
export async function postAcceptInvitation(req: Request, res: Response): Promise<void> {
  const { body } = validated<AcceptInvitationInput>(res);
  await acceptInvitation(body, requestMeta(req));
  res.status(204).end();
}
