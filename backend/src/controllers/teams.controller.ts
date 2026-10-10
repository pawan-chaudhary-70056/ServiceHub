import type { Request, Response } from 'express';
import { addMember, createTeamRecord, getTeamMembers, listTeams, removeMember } from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type { AddTeamMemberInput, CreateTeamInput } from '../validators/team.validators';
import { requestMeta } from './support';

/**
 * Team endpoints (docs/07 §6, docs/11 §9).
 *
 * `GET /teams` is a routing read: any tenant member holds `catalog:read` so they can see
 * which teams exist. Everything that changes membership takes `user:manage` at the route
 * and re-checks tenancy in the service, because team membership is what grants
 * team-scoped visibility over records (docs/07 §6).
 */

/** `GET /teams` — the tenant's active teams, for building assignment and routing pickers. */
export async function getTeams(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listTeams(req.actor);
  res.status(200).json({ items });
}

/** `POST /teams` — creates a team the catalog can route to. */
export async function postTeam(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateTeamInput>(res);
  const team = await createTeamRecord(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/teams/${team.id}`);
  res.status(201).json({ team });
}

/** `GET /teams/{id}/members` — the team and its members. */
export async function getTeamMembersForCaller(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const team = await getTeamMembers(params.id, req.actor);
  res.status(200).json({ team });
}

/** `POST /teams/{id}/members` — adds or re-roles a member (audited). */
export async function postTeamMember(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<AddTeamMemberInput, { id: string }>(res);
  const team = await addMember(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ team });
}

/** `DELETE /teams/{id}/members/{userId}` — removes a member (idempotent, audited). */
export async function deleteTeamMember(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string; userId: string }>(res);
  await removeMember(params.id, params.userId, req.actor, requestMeta(req));
  res.status(204).end();
}
