import type { Request, Response } from 'express';
import { listTeams } from '../services';
import { UnauthenticatedError } from '../utils/errors';

/** `GET /teams` — the tenant's active teams, for building assignment and routing pickers. */
export async function getTeams(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listTeams(req.actor);
  res.status(200).json({ items });
}
