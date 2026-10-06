import type { Request, Response } from 'express';
import { listAssignableRoles } from '../services';
import { UnauthenticatedError } from '../utils/errors';

/**
 * Tenant roles (`docs/11` §9, `07` §3).
 *
 * This exposes only the roles a **tenant administrator** may assign inside their own
 * organization. Platform-scoped roles are excluded by the service query, so the endpoint
 * cannot be used to discover or grant `platform:*` authority (`ADR-0012`, `07` §5).
 */

/** `GET /roles` — the tenant's assignable roles. */
export async function getAssignableRoles(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listAssignableRoles(req.actor);
  res.status(200).json({ items });
}
