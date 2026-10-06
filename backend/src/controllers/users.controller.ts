import type { Request, Response } from 'express';
import { deactivateUser, inviteUser, listTenantUsers } from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type { InviteUserInput } from '../validators/platform.validators';
import { mayDiscloseToken, requestMeta } from './support';

/**
 * Tenant user administration (docs/11 §9, docs/06 §11).
 *
 * Scoping is the whole story here: the route requires `user:manage`, and the service
 * additionally requires the caller to belong to a tenant (`actor.organizationId`), so a
 * platform operator — who has no organization — cannot invite or deactivate tenant users
 * (docs/07 §5 separation of duties). The true tenant predicate is applied in the service
 * query, never as a post-fetch filter (docs/07 §6 stage 2).
 */

/** `GET /users` — cursor-paginated list of the caller's tenant users (`user:manage`). */
export async function getUsers(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<unknown, unknown, { limit: number; cursor?: string }>(res);
  const page = await listTenantUsers(query, req.actor);
  res.status(200).json(page);
}

/** `POST /users` — invites a user into the caller's tenant (`201`). */
export async function postInviteUser(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }

  const { body } = validated<InviteUserInput>(res);
  const invited = await inviteUser(body, req.actor, requestMeta(req));

  res.status(201).json({
    user: { id: invited.userId, email: invited.email },
    invitation: {
      invitationId: invited.invitationId,
      expiresAt: invited.expiresAt,
      ...(mayDiscloseToken() ? { token: invited.token } : {}),
    },
  });
}

/**
 * `POST /users/{id}/deactivate` — retires an identity and revokes its sessions.
 *
 * Deactivation, not deletion: audit-facing identities are never hard-deleted, so the
 * actor of a historical record stays resolvable (docs/31 §3.3).
 */
export async function postDeactivateUser(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }

  const { params } = validated<unknown, { id: string }>(res);
  await deactivateUser(params.id, req.actor, requestMeta(req));
  res.status(204).end();
}
