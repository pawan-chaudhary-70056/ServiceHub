import { assertPermission, type Principal } from '../helpers/authorization';
import { ForbiddenError } from '../utils/errors';
import { listTeamsForOrganization } from '../models';

/**
 * Teams read model — docs/07, F-02.
 *
 * Teams are the ownership and routing unit: a catalog item's fulfilment team becomes the
 * request's default owning team (docs/21 §7), so the catalog admin needs to choose one.
 * This is a read-only surface; team membership management is administration work that
 * arrives with its own document. Scoping is by the caller's tenant, so a platform
 * operator — who belongs to none — sees nothing (docs/07 §5).
 */

const READ_PERMISSION = 'catalog:read';

export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export async function listTeams(actor: Principal): Promise<TeamSummary[]> {
  assertPermission(actor, READ_PERMISSION);
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can list teams.');
  }

  const teams = await listTeamsForOrganization(actor.organizationId);
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    description: team.description,
    isActive: team.isActive,
  }));
}
