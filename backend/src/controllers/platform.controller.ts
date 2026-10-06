import type { Request, Response } from 'express';
import {
  activateOrganization,
  listOperators,
  listOrganizationsPage,
  provisionOrganization,
  suspendOrganization,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type { CreateOrganizationInput } from '../validators/platform.validators';
import { mayDiscloseToken, requestMeta } from './support';

/**
 * Platform administration endpoints (`ADR-0012`, docs/11 §9).
 *
 * These are reachable only by a platform operator: the route requires
 * `platform:organization:manage` / `platform:operator:manage`, and the service asserts
 * the same permission again. Tenant records are never returned here — the operator sees
 * tenants, not their contents (docs/07 §5).
 */

/** `GET /platform/organizations` — cursor-paginated tenant list. */
export async function getOrganizations(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<unknown, unknown, { limit: number; cursor?: string }>(res);
  const page = await listOrganizationsPage(query, req.actor);
  res.status(200).json(page);
}

/**
 * `POST /platform/organizations` — provisions a tenant and its first administrator.
 *
 * `201` with `Location` pointing at the new tenant (docs/11 §3). The invitation token is
 * included only outside production (`support.mayDiscloseToken`): in production it travels
 * solely in the queued email, so the endpoint cannot be used to mint onboarding links.
 */
export async function postOrganization(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }

  const { body } = validated<CreateOrganizationInput>(res);
  const result = await provisionOrganization(body, req.actor, requestMeta(req));

  res.setHeader('Location', `/api/v1/platform/organizations/${result.organization.id}`);
  res.status(201).json({
    organization: result.organization,
    administrator: result.administrator,
    invitation: {
      invitationId: result.invitation.invitationId,
      expiresAt: result.invitation.expiresAt,
      ...(mayDiscloseToken() ? { token: result.invitation.token } : {}),
    },
  });
}

/** `POST /platform/organizations/{id}/suspend` — suspends a tenant. */
export async function postSuspendOrganization(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const organization = await suspendOrganization(params.id, req.actor, requestMeta(req));
  res.status(200).json({ organization });
}

/** `POST /platform/organizations/{id}/activate` — reactivates a suspended tenant. */
export async function postActivateOrganization(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const organization = await activateOrganization(params.id, req.actor, requestMeta(req));
  res.status(200).json({ organization });
}

/** `GET /platform/operators` — the platform operator roster. */
export async function getOperators(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listOperators(req.actor);
  res.status(200).json({ items });
}
