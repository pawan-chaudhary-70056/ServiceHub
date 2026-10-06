import { Prisma } from '@prisma/client';
import type {
  Incident,
  IncidentImpact,
  IncidentStatus,
  IncidentUrgency,
  Priority,
} from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * Incident data access — docs/23, F-06.
 *
 * Incidents and requests share a shape but not a lifecycle (`docs/08` §3), so they get
 * their own table and their own queries. The rules the database must own are the same as
 * for requests:
 *
 *   - **Tenant scope is a predicate, never a post-filter** (`ADR-0002`): every read takes
 *     `organizationId` and applies it inside the query.
 *   - **Read scope** (`own` / `team` / `any`) is resolved from the caller's permissions
 *     in the service and passed down, so the SQL is the narrowest the caller allows
 *     (`docs/22` §10, applied identically by `docs/23` §9).
 *   - **`resolutionSummary` is required for RESOLVED/CLOSED** and that is enforced by a
 *     CHECK constraint in the migration, not only here (`docs/23` §4).
 *
 * Only `services/` may import this module (`docs/03` §4).
 */

export type IncidentScope = 'own' | 'team' | 'any';

export interface IncidentListParams {
  organizationId: string;
  scope: IncidentScope;
  userId: string;
  teamIds: string[];
  status?: IncidentStatus;
  /** When true, major incidents are listed first regardless of age (`docs/23` §11). */
  majorOnly?: boolean;
  limit: number;
  cursor?: string;
}

export interface IncidentWithRelations extends Incident {
  reporter: { id: string; email: string; displayName: string };
  assignee: { id: string; email: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  slaPolicy: { id: string; name: string };
}

const INCIDENT_INCLUDE = {
  reporter: { select: { id: true, email: true, displayName: true } },
  assignee: { select: { id: true, email: true, displayName: true } },
  team: { select: { id: true, name: true } },
  slaPolicy: { select: { id: true, name: true } },
} satisfies Prisma.IncidentInclude;

export function createIncident(
  data: {
    organizationId: string;
    reference: string;
    title: string;
    description: string;
    impact: IncidentImpact;
    urgency: IncidentUrgency;
    priority: Priority;
    isMajor: boolean;
    reporterId: string;
    teamId: string | null;
    slaPolicyId: string;
  },
  client: DataClient = prisma,
): Promise<Incident> {
  return client.incident.create({ data });
}

export function findIncidentById(
  id: string,
  client: DataClient = prisma,
): Promise<IncidentWithRelations | null> {
  return client.incident.findUnique({ where: { id }, include: INCIDENT_INCLUDE });
}

/**
 * Lists incidents visible to the caller under a scope (`docs/23` §11).
 *
 * `own` → reported by the caller; `team` → they reported, are assigned, or their team
 * owns it; `any` → the whole tenant. Major incidents sort first so a critical event is
 * never buried by age, then newest-first, cursor-paginated.
 */
export function listIncidents(
  params: IncidentListParams,
  client: DataClient = prisma,
): Promise<IncidentWithRelations[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  // Scope and cursor each express an `OR`, so they are combined under `AND` — assigning
  // both to one object would silently drop one and un-scope the list (`docs/22` §10).
  const conditions: Prisma.IncidentWhereInput[] = [];

  if (params.scope === 'own') {
    conditions.push({ reporterId: params.userId });
  } else if (params.scope === 'team') {
    conditions.push({
      OR: [
        { reporterId: params.userId },
        { assigneeId: params.userId },
        { teamId: { in: params.teamIds } },
      ],
    });
  }

  if (params.cursor) {
    conditions.push({
      OR: [
        { createdAt: { lt: new Date(sortValue) } },
        { createdAt: new Date(sortValue), id: { lt: id } },
      ],
    });
  }

  return client.incident.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.majorOnly ? { isMajor: true } : {}),
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    },
    include: INCIDENT_INCLUDE,
    orderBy: [{ isMajor: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });
}

export function updateIncident(
  id: string,
  data: Partial<{
    title: string;
    description: string;
    impact: IncidentImpact;
    urgency: IncidentUrgency;
    priority: Priority;
    isMajor: boolean;
    status: IncidentStatus;
    assigneeId: string | null;
    teamId: string | null;
    resolutionSummary: string | null;
    reopenCount: number;
    resolvedAt: Date | null;
    closedAt: Date | null;
  }>,
  client: DataClient = prisma,
): Promise<Incident> {
  return client.incident.update({ where: { id }, data });
}
