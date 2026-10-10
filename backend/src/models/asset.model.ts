import type {
  Asset,
  AssetAssignment,
  AssetHolderType,
  AssetState,
  AssetType,
  Prisma,
  Team,
  User,
} from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';
import { reserveReferenceValue } from './reference.model';

/**
 * Asset-register data access — docs/28, F-16.
 *
 * The register answers three questions: *what do we have*, *who holds it*, and *what is
 * it connected to*. Two invariants shape the queries:
 *
 *   - **AM1/AM3** — assignments are history and at most one is open per asset. The
 *     database enforces the "at most one open" half with a partial unique index
 *     (`asset_assignments_one_open_per_asset`); this module never writes an assignment
 *     without closing the previous one first.
 *   - **AM6** — `state` and the presence of an open assignment must agree. They are
 *     written together, in one transaction, from the service.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

/** The caller's read scope for assets (`docs/28` §6). */
export type AssetScope = 'ANY' | 'OWN';

export interface AssetHolderUser {
  id: string;
  displayName: string;
}
export interface AssetHolderTeam {
  id: string;
  name: string;
}

export interface OpenAssignment {
  id: string;
  holderType: AssetHolderType;
  userId: string | null;
  teamId: string | null;
  assignedAt: Date;
  assignedById: string;
  notes: string | null;
}

export interface AssetWithRelations extends Asset {
  assetType: Pick<AssetType, 'id' | 'key' | 'name'>;
  assignedToUser: Pick<User, 'id' | 'displayName' | 'email'> | null;
  assignedToTeam: Pick<Team, 'id' | 'name'> | null;
  assignments: AssetAssignment[];
}

export interface AssetListRow extends Asset {
  assetType: Pick<AssetType, 'id' | 'key' | 'name'>;
  assignedToUser: Pick<User, 'id' | 'displayName'> | null;
  assignedToTeam: Pick<Team, 'id' | 'name'> | null;
}

const assetTypeSelect = { select: { id: true, key: true, name: true } } as const;

// ---------------------------------------------------------------------------
// Asset types
// ---------------------------------------------------------------------------

export function listAssetTypes(
  organizationId: string,
  client: DataClient = prisma,
): Promise<AssetType[]> {
  return client.assetType.findMany({
    where: { organizationId },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
}

export function findAssetTypeById(
  id: string,
  client: DataClient = prisma,
): Promise<AssetType | null> {
  return client.assetType.findUnique({ where: { id } });
}

export function findAssetTypeByKey(
  organizationId: string,
  key: string,
  client: DataClient = prisma,
): Promise<AssetType | null> {
  return client.assetType.findUnique({ where: { organizationId_key: { organizationId, key } } });
}

export function createAssetType(
  data: {
    organizationId: string;
    key: string;
    name: string;
    description: string | null;
    attributeSchema: Prisma.InputJsonValue;
  },
  client: DataClient = prisma,
): Promise<AssetType> {
  return client.assetType.create({ data });
}

export function updateAssetType(
  id: string,
  data: {
    name?: string;
    description?: string | null;
    isActive?: boolean;
    attributeSchema?: Prisma.InputJsonValue;
  },
  client: DataClient = prisma,
): Promise<AssetType> {
  return client.assetType.update({ where: { id }, data });
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export function findAssetById(
  id: string,
  client: DataClient = prisma,
): Promise<AssetWithRelations | null> {
  return client.asset.findUnique({
    where: { id },
    include: {
      assetType: assetTypeSelect,
      assignedToUser: { select: { id: true, displayName: true, email: true } },
      assignedToTeam: { select: { id: true, name: true } },
      assignments: { orderBy: { assignedAt: 'desc' } },
    },
  });
}

export function findAssetByTag(
  organizationId: string,
  tag: string,
  client: DataClient = prisma,
): Promise<Asset | null> {
  return client.asset.findUnique({ where: { organizationId_tag: { organizationId, tag } } });
}

/** `serialNumber` is unique per tenant when present (rule AM2). */
export function findAssetBySerialNumber(
  organizationId: string,
  serialNumber: string,
  client: DataClient = prisma,
): Promise<Asset | null> {
  return client.asset.findFirst({ where: { organizationId, serialNumber } });
}

export interface ListAssetsParams {
  organizationId: string;
  scope: AssetScope;
  /** The caller, for the `OWN` scope predicate (assets they hold). */
  userId: string;
  state?: AssetState;
  assetTypeId?: string;
  /** Narrow to one holder — always applied *with* the tenant predicate, never instead. */
  holderUserId?: string;
  limit: number;
  cursor?: string;
}

/**
 * Cursor-paginated asset list. The scope predicate is part of the query (never a
 * post-fetch filter), so an unauthorised asset is not merely hidden from the page — it
 * is not selected (`docs/07` §1 stage 2).
 */
export function listAssets(params: ListAssetsParams): Promise<AssetListRow[]> {
  const where: Prisma.AssetWhereInput = { organizationId: params.organizationId };
  if (params.scope === 'OWN') where.assignedToUserId = params.userId;
  if (params.state) where.state = params.state;
  if (params.assetTypeId) where.assetTypeId = params.assetTypeId;
  if (params.holderUserId) where.assignedToUserId = params.holderUserId;

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    const createdAt = new Date(decoded.sortValue);
    where.AND = [{ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: decoded.id } }] }];
  }

  return prisma.asset.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
    include: {
      assetType: assetTypeSelect,
      assignedToUser: { select: { id: true, displayName: true } },
      assignedToTeam: { select: { id: true, name: true } },
    },
  });
}

export interface CreateAssetData {
  organizationId: string;
  assetTypeId: string;
  tag: string;
  serialNumber: string | null;
  name: string;
  description: string | null;
  state: AssetState;
  attributes: Prisma.InputJsonValue;
  purchaseDate: Date | null;
  warrantyExpiresAt: Date | null;
}

export function createAsset(data: CreateAssetData, client: DataClient = prisma): Promise<Asset> {
  return client.asset.create({ data });
}

export function updateAsset(
  id: string,
  data: Prisma.AssetUncheckedUpdateInput,
  client: DataClient = prisma,
): Promise<Asset> {
  return client.asset.update({ where: { id }, data });
}

/**
 * Allocates the next `AST-000123` tag atomically, per tenant (`docs/28` §3).
 *
 * A read-then-write `max()+1` is a race; the atomic upsert in `reference.model.ts` is not,
 * and it cannot abort the caller's transaction the way a caught unique violation would
 * (`docs/22` §4).
 */
export async function allocateAssetTag(
  organizationId: string,
  client: DataClient = prisma,
): Promise<string> {
  const value = await reserveReferenceValue(organizationId, 'AST', 'ALL', client);
  return `AST-${String(value).padStart(6, '0')}`;
}

export function countAssetsByState(
  organizationId: string,
  client: DataClient = prisma,
): Promise<Array<{ state: AssetState; count: number }>> {
  return client.asset
    .groupBy({ by: ['state'], where: { organizationId }, _count: { _all: true } })
    .then((rows) => rows.map((row) => ({ state: row.state, count: row._count._all })));
}

// ---------------------------------------------------------------------------
// Assignments — history, never deleted (rule AM3)
// ---------------------------------------------------------------------------

/** The single open assignment, if any (rule AM1). */
export function findOpenAssignment(
  assetId: string,
  client: DataClient = prisma,
): Promise<AssetAssignment | null> {
  return client.assetAssignment.findFirst({
    where: { assetId, returnedAt: null },
    orderBy: { assignedAt: 'desc' },
  });
}

export function listAssignments(
  assetId: string,
  client: DataClient = prisma,
): Promise<AssetAssignment[]> {
  return client.assetAssignment.findMany({
    where: { assetId },
    orderBy: { assignedAt: 'desc' },
  });
}

export function createAssignment(
  data: {
    organizationId: string;
    assetId: string;
    holderType: AssetHolderType;
    userId: string | null;
    teamId: string | null;
    assignedAt: Date;
    assignedById: string;
    notes: string | null;
  },
  client: DataClient = prisma,
): Promise<AssetAssignment> {
  return client.assetAssignment.create({ data });
}

/** Closes the open assignment with `returnedAt`; the row itself is never removed (AM3). */
export async function closeOpenAssignment(
  assetId: string,
  returnedAt: Date,
  notes: string | null,
  client: DataClient = prisma,
): Promise<number> {
  const result = await client.assetAssignment.updateMany({
    where: { assetId, returnedAt: null },
    data: { returnedAt, ...(notes === null ? {} : { notes }) },
  });
  return result.count;
}
