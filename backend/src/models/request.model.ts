import { Prisma } from '@prisma/client';
import type {
  CatalogFieldType,
  RequestFieldValue,
  RequestStatus,
  ServiceRequest,
} from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * Service request data access — docs/22, F-05.
 *
 * The queries here carry the two rules the database must own:
 *
 *   - **Tenant scope is a predicate, never a post-filter** (`ADR-0002`): every read takes
 *     `organizationId` and applies it inside the query, so a list cannot leak another
 *     tenant's rows because a caller forgot to filter.
 *   - **Read scope** (own / team / any) is resolved from the caller's permissions in the
 *     service and passed down as a `scope`, so the SQL is the narrowest the caller allows
 *     (docs/22 §10).
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export type RequestScope = 'own' | 'team' | 'any';

export interface RequestListParams {
  organizationId: string;
  scope: RequestScope;
  userId: string;
  teamIds: string[];
  status?: RequestStatus;
  limit: number;
  cursor?: string;
}

export interface RequestWithRelations extends ServiceRequest {
  catalogItem: { id: string; name: string; requiresApproval: boolean };
  requester: { id: string; email: string; displayName: string };
  assignee: { id: string; email: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  slaPolicy: { id: string; name: string };
  fieldValues: RequestFieldValue[];
}

const REQUEST_INCLUDE = {
  catalogItem: { select: { id: true, name: true, requiresApproval: true } },
  requester: { select: { id: true, email: true, displayName: true } },
  assignee: { select: { id: true, email: true, displayName: true } },
  team: { select: { id: true, name: true } },
  slaPolicy: { select: { id: true, name: true } },
  fieldValues: { orderBy: { displayOrder: 'asc' } },
} satisfies Prisma.ServiceRequestInclude;

export interface RequestFieldSnapshot {
  fieldKey: string;
  fieldLabel: string;
  fieldType: CatalogFieldType;
  value: Prisma.InputJsonValue | null;
  displayOrder: number;
}

export function createServiceRequest(
  data: {
    organizationId: string;
    reference: string;
    catalogItemId: string;
    requesterId: string;
    teamId: string | null;
    priority: ServiceRequest['priority'];
    title: string;
    description: string | null;
    slaPolicyId: string;
    fieldSnapshot: Prisma.InputJsonValue;
  },
  client: DataClient = prisma,
): Promise<ServiceRequest> {
  return client.serviceRequest.create({ data });
}

export function createRequestFieldValues(
  requestId: string,
  values: RequestFieldSnapshot[],
  client: DataClient = prisma,
): Promise<Prisma.BatchPayload> {
  if (values.length === 0) {
    return Promise.resolve({ count: 0 });
  }
  return client.requestFieldValue.createMany({
    data: values.map((value) => ({
      requestId,
      fieldKey: value.fieldKey,
      fieldLabel: value.fieldLabel,
      fieldType: value.fieldType,
      displayOrder: value.displayOrder,
      // A missing answer is SQL NULL (`DbNull`), not the JSON literal `null`, so a
      // "no value" and a deliberate JSON null are not conflated.
      value: value.value === null ? Prisma.DbNull : value.value,
    })),
  });
}

export function findRequestById(
  id: string,
  client: DataClient = prisma,
): Promise<RequestWithRelations | null> {
  return client.serviceRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
}

/**
 * Lists requests visible to the caller under a scope (docs/22 §10).
 *
 * `own` → the requester's own; `team` → items they are assigned, own, or that their teams
 * own; `any` → the whole tenant. Cursor-paginated, newest-first, fetching `limit + 1` so
 * `hasMore` needs no second count query.
 */
export function listRequests(
  params: RequestListParams,
  client: DataClient = prisma,
): Promise<RequestWithRelations[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  // The scope and the cursor each express an `OR`, so they are combined under `AND`.
  // Assigning both to the same object would silently drop one of them — the classic way
  // a scoped list stops being scoped once a cursor is supplied.
  const conditions: Prisma.ServiceRequestWhereInput[] = [];

  if (params.scope === 'own') {
    conditions.push({ requesterId: params.userId });
  } else if (params.scope === 'team') {
    conditions.push({
      OR: [
        { requesterId: params.userId },
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

  return client.serviceRequest.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.status ? { status: params.status } : {}),
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    },
    include: REQUEST_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });
}

export function updateServiceRequest(
  id: string,
  data: Partial<{
    status: RequestStatus;
    assigneeId: string | null;
    teamId: string | null;
    priority: ServiceRequest['priority'];
    title: string;
    description: string | null;
    resolvedAt: Date | null;
    closedAt: Date | null;
  }>,
  client: DataClient = prisma,
): Promise<ServiceRequest> {
  return client.serviceRequest.update({ where: { id }, data });
}

export function countRequestsForCatalogItem(
  catalogItemId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.serviceRequest.count({ where: { catalogItemId } });
}
