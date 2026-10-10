import type { Request, Response } from 'express';
import { getRosterSyncStatusForCaller, triggerRosterSyncForCaller } from '../services';
import { directoryAdapter } from '../integrations/directory';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type { RosterSyncBody } from '../validators/roster-sync.validators';
import { requestMeta } from './support';

/**
 * Roster sync administration (`docs/32` §6/§12).
 *
 * `GET` reports the last run's outcome and the number of mapped people; `POST` runs a sync
 * now, which is an audited operator action. The service owns the drift guard: an operator who
 * intends a large removal must pass `confirmDrift`, and the audit records whether they did.
 */

/** `GET /admin/integrations/roster-sync` — the last run's outcome (`integration:read`). */
export async function getRosterSyncStatus(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json({ rosterSync: await getRosterSyncStatusForCaller(req.actor) });
}

/** `POST /admin/integrations/roster-sync` — runs a sync now (`integration:manage`, audited). */
export async function postRosterSync(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<RosterSyncBody>(res);
  const result = await triggerRosterSyncForCaller(directoryAdapter, req.actor, requestMeta(req), {
    confirmDrift: body.confirmDrift ?? false,
  });
  res.status(200).json({ rosterSync: result });
}
