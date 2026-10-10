import type { AssetState, AssetType, Prisma } from '@prisma/client';
import {
  assertAnyPermission,
  assertPermission,
  hasPermission,
  type Principal,
} from '../helpers/authorization';
import { ConflictError, DuplicateError, NotFoundError } from '../utils/errors';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  allocateAssetTag,
  closeOpenAssignment,
  countAssetsByState,
  createAsset,
  createAssignment,
  createAssetType,
  findAssetById,
  findAssetBySerialNumber,
  findAssetByTag,
  findAssetTypeById,
  findAssetTypeByKey,
  findOpenAssignment,
  findUserById,
  listAssetTypes,
  listAssets,
  findTeamById,
  listAssignments,
  runInTransaction,
  updateAsset,
  updateAssetType,
  writeAudit,
  type AssetScope,
  type AssetWithRelations,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Asset register — docs/28, F-16.
 *
 * Three invariants are enforced here, and each one is a defect that makes "who holds it"
 * unanswerable if it slips:
 *
 *   - **AM1** — an asset cannot be assigned while it already has an open assignment. The
 *     database has a partial unique index as the backstop; this service is the first
 *     control.
 *   - **AM3** — assignments are history. Returning an asset sets `returnedAt`; nothing is
 *     deleted.
 *   - **AM6** — `state` and the open assignment agree. They are written in the same
 *     transaction so no path can leave an `ASSIGNED` asset with no holder, or a holder
 *     with no open assignment.
 *
 * **Linking is not ownership transfer** (§7): referencing an asset on a record never
 * changes the holder — only an explicit assignment does, and that is audited.
 */

const RETIRED_STATES: AssetState[] = ['RETIRED', 'DISPOSED'];

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new NotFoundError('Asset records are tenant-scoped.');
  }
  return actor.organizationId;
}

/** The widest asset read scope the caller holds (`docs/28` §6). */
export function resolveAssetScope(actor: Principal): AssetScope {
  return hasPermission(actor, 'asset:read.any') ? 'ANY' : 'OWN';
}

export interface AssetHolder {
  type: 'USER' | 'TEAM' | null;
  user: { id: string; displayName: string; email: string } | null;
  team: { id: string; name: string } | null;
}

export interface AssetView {
  id: string;
  tag: string;
  serialNumber: string | null;
  name: string;
  description: string | null;
  state: AssetState;
  attributes: Record<string, unknown>;
  assetType: { id: string; key: string; name: string };
  holder: AssetHolder;
  openAssignment: {
    id: string;
    assignedAt: Date;
    assignedById: string;
    notes: string | null;
  } | null;
  assignments: Array<{
    id: string;
    holderType: 'USER' | 'TEAM';
    userId: string | null;
    teamId: string | null;
    assignedAt: Date;
    returnedAt: Date | null;
    assignedById: string;
    notes: string | null;
  }>;
  purchaseDate: Date | null;
  warrantyExpiresAt: Date | null;
  /** Derived from `warrantyExpiresAt`, never stored (`docs/28` rule AM9). */
  warrantyExpired: boolean;
  retiredAt: Date | null;
  disposedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetListItem {
  id: string;
  tag: string;
  serialNumber: string | null;
  name: string;
  state: AssetState;
  assetType: { id: string; key: string; name: string };
  holder: AssetHolder;
  warrantyExpiresAt: Date | null;
  createdAt: Date;
}

function holderOf(asset: AssetWithRelations): AssetHolder {
  if (asset.assignedToUser) {
    return {
      type: 'USER',
      user: {
        id: asset.assignedToUser.id,
        displayName: asset.assignedToUser.displayName,
        email: asset.assignedToUser.email,
      },
      team: null,
    };
  }
  if (asset.assignedToTeam) {
    return {
      type: 'TEAM',
      user: null,
      team: { id: asset.assignedToTeam.id, name: asset.assignedToTeam.name },
    };
  }
  return { type: null, user: null, team: null };
}

function toListItem(asset: AssetWithRelations): AssetListItem {
  return {
    id: asset.id,
    tag: asset.tag,
    serialNumber: asset.serialNumber,
    name: asset.name,
    state: asset.state,
    assetType: asset.assetType,
    holder: holderOf(asset),
    warrantyExpiresAt: asset.warrantyExpiresAt,
    createdAt: asset.createdAt,
  };
}

function toView(asset: AssetWithRelations): AssetView {
  const open = asset.assignments.find((assignment) => assignment.returnedAt === null);
  return {
    id: asset.id,
    tag: asset.tag,
    serialNumber: asset.serialNumber,
    name: asset.name,
    description: asset.description,
    state: asset.state,
    attributes: (asset.attributes ?? {}) as Record<string, unknown>,
    assetType: asset.assetType,
    holder: holderOf(asset),
    openAssignment: open
      ? {
          id: open.id,
          assignedAt: open.assignedAt,
          assignedById: open.assignedById,
          notes: open.notes,
        }
      : null,
    assignments: asset.assignments.map((assignment) => ({
      id: assignment.id,
      holderType: assignment.holderType,
      userId: assignment.userId,
      teamId: assignment.teamId,
      assignedAt: assignment.assignedAt,
      returnedAt: assignment.returnedAt,
      assignedById: assignment.assignedById,
      notes: assignment.notes,
    })),
    purchaseDate: asset.purchaseDate,
    warrantyExpiresAt: asset.warrantyExpiresAt,
    warrantyExpired: Boolean(
      asset.warrantyExpiresAt && asset.warrantyExpiresAt.getTime() < Date.now(),
    ),
    retiredAt: asset.retiredAt,
    disposedAt: asset.disposedAt,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

/**
 * The object-level read rule (docs/07 stage 3): a holder may read their own asset, a
 * caller with `asset:read.any` may read any. Everyone else receives `NOT_FOUND`.
 */
function assertAssetReadable(asset: AssetWithRelations, actor: Principal): void {
  if (resolveAssetScope(actor) === 'ANY') return;
  if (asset.assignedToUserId === actor.userId) return;
  throw new NotFoundError('Asset not found.');
}

async function loadReadable(id: string, actor: Principal): Promise<AssetWithRelations> {
  const organizationId = requireTenant(actor);
  assertAssetRead(actor);
  const asset = await findAssetById(id);
  if (!asset || asset.organizationId !== organizationId) {
    throw new NotFoundError('Asset not found.');
  }
  assertAssetReadable(asset, actor);
  return asset;
}

/**
 * Object-level visibility check for an asset, reused by projections that must not become a
 * back door (e.g. a record's audit history, `docs/31` §5). A caller who may not read the
 * asset receives NOT_FOUND, exactly as a direct read would.
 */
export function assertAssetVisible(id: string, actor: Principal): Promise<AssetWithRelations> {
  return loadReadable(id, actor);
}

/** Reading is `asset:read.own` **or** `.any` — either grant is sufficient (`docs/07` §3). */
function assertAssetRead(actor: Principal): void {
  assertAnyPermission(actor, ['asset:read.own', 'asset:read.any']);
}

/** Required attributes declared by the type must be present (rule AM7). */
function assertRequiredAttributes(
  assetType: Pick<AssetType, 'attributeSchema'>,
  attributes: Record<string, unknown>,
): void {
  const schema = (assetType.attributeSchema ?? {}) as { required?: unknown };
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const missing = required.filter(
    (key) => attributes[key] === undefined || attributes[key] === null || attributes[key] === '',
  );
  if (missing.length > 0) {
    throw new ConflictError(`The asset type requires the attribute(s): ${missing.join(', ')}.`);
  }
}

// ===========================================================================
// Reads
// ===========================================================================

export interface ListAssetsInput {
  state?: AssetState;
  assetTypeId?: string;
  holderUserId?: string;
  limit: number;
  cursor?: string;
}

export async function listAssetsPage(
  input: ListAssetsInput,
  actor: Principal,
): Promise<CursorPage<AssetListItem>> {
  const organizationId = requireTenant(actor);
  assertAssetRead(actor);

  const rows = await listAssets({
    organizationId,
    scope: resolveAssetScope(actor),
    userId: actor.userId,
    state: input.state,
    assetTypeId: input.assetTypeId,
    holderUserId: input.holderUserId,
    limit: input.limit,
    cursor: input.cursor,
  });

  const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);
  return { ...page, items: page.items.map((row) => toListItem(row as AssetWithRelations)) };
}

export async function getAsset(id: string, actor: Principal): Promise<AssetView> {
  return toView(await loadReadable(id, actor));
}

/** Resolves a tag (`AST-000123`) to its asset — the register's second key. */
export async function getAssetByTag(tag: string, actor: Principal): Promise<AssetView> {
  const organizationId = requireTenant(actor);
  assertAssetRead(actor);
  const asset = await findAssetByTag(organizationId, tag);
  if (!asset) throw new NotFoundError('Asset not found.');
  return getAsset(asset.id, actor);
}

export async function getAssetStats(
  actor: Principal,
): Promise<{ byState: Array<{ state: AssetState; count: number }> }> {
  const organizationId = requireTenant(actor);
  assertAssetRead(actor);
  return { byState: await countAssetsByState(organizationId) };
}

// ===========================================================================
// Asset types
// ===========================================================================

export interface CreateAssetTypeInput {
  key: string;
  name: string;
  description?: string | null;
  attributeSchema?: Record<string, unknown>;
}

export async function createAssetTypeDefinition(
  input: CreateAssetTypeInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetType> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'admin:config');

  const key = input.key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  const existing = await findAssetTypeByKey(organizationId, key);
  if (existing) {
    throw new DuplicateError('An asset type with that key already exists.');
  }

  return runInTransaction(async (tx) => {
    const created = await createAssetType(
      {
        organizationId,
        key,
        name: input.name,
        description: input.description ?? null,
        attributeSchema: (input.attributeSchema ?? {}) as Prisma.InputJsonValue,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_TYPE_CREATE,
        entityType: AUDIT_ENTITY.ASSET_TYPE,
        entityId: created.id,
        after: { key: created.key, name: created.name },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return created;
  });
}

export async function updateAssetTypeDefinition(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    isActive?: boolean;
    attributeSchema?: Record<string, unknown>;
  },
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetType> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'admin:config');
  const existing = await findAssetTypeById(id);
  if (!existing || existing.organizationId !== organizationId) {
    throw new NotFoundError('Asset type not found.');
  }

  const data: Parameters<typeof updateAssetType>[1] = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.attributeSchema !== undefined) {
    data.attributeSchema = input.attributeSchema as Prisma.InputJsonValue;
  }

  return runInTransaction(async (tx) => {
    const updated = await updateAssetType(id, data, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_TYPE_UPDATE,
        entityType: AUDIT_ENTITY.ASSET_TYPE,
        entityId: id,
        before: { name: existing.name, isActive: existing.isActive },
        after: { name: updated.name, isActive: updated.isActive },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return updated;
  });
}

export function listAssetTypeDefinitions(actor: Principal): Promise<AssetType[]> {
  const organizationId = requireTenant(actor);
  assertAssetRead(actor);
  return listAssetTypes(organizationId);
}

// ===========================================================================
// Register mutations
// ===========================================================================

export interface CreateAssetInput {
  assetTypeId: string;
  name: string;
  description?: string | null;
  serialNumber?: string | null;
  /** A new asset begins life `PROCURED` or `IN_STOCK` (docs/28 §4). */
  state?: Extract<AssetState, 'PROCURED' | 'IN_STOCK'>;
  attributes?: Record<string, unknown>;
  purchaseDate?: string | null;
  warrantyExpiresAt?: string | null;
}

export async function createAssetRecord(
  input: CreateAssetInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'asset:manage');

  const assetType = await findAssetTypeById(input.assetTypeId);
  if (!assetType || assetType.organizationId !== organizationId) {
    throw new NotFoundError('Asset type not found.');
  }
  if (!assetType.isActive) {
    throw new ConflictError('The asset type is no longer available.');
  }
  const attributes = (input.attributes ?? {}) as Record<string, unknown>;
  assertRequiredAttributes(assetType, attributes);
  if (input.serialNumber) {
    const clash = await findAssetBySerialNumber(organizationId, input.serialNumber);
    if (clash) throw new DuplicateError('That serial number is already registered.');
  }

  const created = await runInTransaction(async (tx) => {
    const tag = await allocateAssetTag(organizationId, tx);
    const asset = await createAsset(
      {
        organizationId,
        assetTypeId: assetType.id,
        tag,
        serialNumber: input.serialNumber ?? null,
        name: input.name,
        description: input.description ?? null,
        state: input.state ?? 'PROCURED',
        attributes: attributes as Prisma.InputJsonValue,
        purchaseDate: input.purchaseDate ? new Date(input.purchaseDate) : null,
        warrantyExpiresAt: input.warrantyExpiresAt ? new Date(input.warrantyExpiresAt) : null,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_CREATE,
        entityType: AUDIT_ENTITY.ASSET,
        entityId: asset.id,
        after: { tag: asset.tag, name: asset.name, state: asset.state, assetTypeId: assetType.id },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return asset;
  });

  return getAsset(created.id, actor);
}

export interface UpdateAssetInput {
  name?: string;
  description?: string | null;
  serialNumber?: string | null;
  attributes?: Record<string, unknown>;
  purchaseDate?: string | null;
  warrantyExpiresAt?: string | null;
  /** Only stock/in-repair moves are editable directly; assignment and disposal are actions. */
  state?: Extract<AssetState, 'PROCURED' | 'IN_STOCK' | 'IN_REPAIR'>;
}

export async function updateAssetRecord(
  id: string,
  input: UpdateAssetInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetView> {
  const asset = await loadManageable(id, actor);

  if (input.state !== undefined && asset.state === 'ASSIGNED') {
    throw new ConflictError('Return the asset before changing its state (AM6).');
  }
  if (RETIRED_STATES.includes(asset.state)) {
    throw new ConflictError('A retired or disposed asset is read-only.');
  }

  const assetType = await findAssetTypeById(asset.assetTypeId);
  const data: Prisma.AssetUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.serialNumber !== undefined) {
    if (input.serialNumber) {
      const clash = await findAssetBySerialNumber(asset.organizationId, input.serialNumber);
      if (clash && clash.id !== asset.id) {
        throw new DuplicateError('That serial number is already registered.');
      }
    }
    data.serialNumber = input.serialNumber;
  }
  if (input.state !== undefined) data.state = input.state;
  if (input.purchaseDate !== undefined) {
    data.purchaseDate = input.purchaseDate ? new Date(input.purchaseDate) : null;
  }
  if (input.warrantyExpiresAt !== undefined) {
    data.warrantyExpiresAt = input.warrantyExpiresAt ? new Date(input.warrantyExpiresAt) : null;
  }
  if (input.attributes !== undefined) {
    if (assetType) assertRequiredAttributes(assetType, input.attributes);
    data.attributes = input.attributes as Prisma.InputJsonValue;
  }

  await runInTransaction(async (tx) => {
    await updateAsset(id, data, tx);
    await writeAudit(
      {
        organizationId: asset.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_UPDATE,
        entityType: AUDIT_ENTITY.ASSET,
        entityId: id,
        before: { name: asset.name, state: asset.state, serialNumber: asset.serialNumber },
        after: {
          name: input.name ?? asset.name,
          state: input.state ?? asset.state,
          serialNumber: input.serialNumber ?? asset.serialNumber,
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return getAsset(id, actor);
}

async function loadManageable(id: string, actor: Principal): Promise<AssetWithRelations> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'asset:manage');
  const asset = await findAssetById(id);
  if (!asset || asset.organizationId !== organizationId) {
    throw new NotFoundError('Asset not found.');
  }
  return asset;
}

export interface AssignAssetInput {
  holderType: 'USER' | 'TEAM';
  userId?: string | null;
  teamId?: string | null;
  notes?: string | null;
}

/**
 * Assigns an asset, opening an assignment interval (`docs/28` §4).
 *
 * Refused when an assignment is already open (AM1), when the asset is retired or disposed
 * (read-only for new assignments), or when the holder is a deactivated user (§10).
 */
export async function assignAsset(
  id: string,
  input: AssignAssetInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'asset:assign');
  const asset = await findAssetById(id);
  if (!asset || asset.organizationId !== organizationId) {
    throw new NotFoundError('Asset not found.');
  }
  if (RETIRED_STATES.includes(asset.state)) {
    throw new ConflictError('A retired or disposed asset cannot be assigned.');
  }
  const open = await findOpenAssignment(asset.id);
  if (open) {
    throw new ConflictError('The asset already has an open assignment (AM1).');
  }

  let userId: string | null = null;
  let teamId: string | null = null;
  if (input.holderType === 'USER') {
    const holderId = input.userId ?? null;
    if (!holderId) throw new ConflictError('A user holder is required.');
    const user = await findUserById(holderId);
    if (!user || user.organizationId !== organizationId) {
      throw new NotFoundError('Holder not found.');
    }
    if (user.status !== 'ACTIVE') {
      throw new ConflictError('A deactivated user cannot hold an asset.');
    }
    userId = holderId;
  } else {
    const holderId = input.teamId ?? null;
    if (!holderId) throw new ConflictError('A team holder is required.');
    const holderTeam = await findTeamById(holderId);
    if (!holderTeam || holderTeam.organizationId !== organizationId) {
      throw new NotFoundError('Holder team not found.');
    }
    if (!holderTeam.isActive) {
      throw new ConflictError('An inactive team cannot hold an asset.');
    }
    userId = null;
    teamId = holderId;
  }

  const now = new Date();
  await runInTransaction(async (tx) => {
    await createAssignment(
      {
        organizationId,
        assetId: asset.id,
        holderType: input.holderType,
        userId,
        teamId,
        assignedAt: now,
        assignedById: actor.userId,
        notes: input.notes ?? null,
      },
      tx,
    );
    // AM6: state and the open assignment are written together, in one transaction.
    await updateAsset(
      asset.id,
      {
        state: 'ASSIGNED',
        assignedToUserId: userId,
        assignedToTeamId: teamId,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_ASSIGN,
        entityType: AUDIT_ENTITY.ASSET,
        entityId: asset.id,
        before: { state: asset.state, assignedToUserId: asset.assignedToUserId },
        after: { state: 'ASSIGNED', holderType: input.holderType, userId, teamId },
        reason: input.notes ?? null,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return getAsset(asset.id, actor);
}

/** Returns an asset: closes the open assignment and clears the holder (AM3, AM6). */
export async function returnAsset(
  id: string,
  input: { notes?: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'asset:assign');
  const asset = await findAssetById(id);
  if (!asset || asset.organizationId !== organizationId) {
    throw new NotFoundError('Asset not found.');
  }
  const open = await findOpenAssignment(asset.id);
  if (!open) {
    throw new ConflictError('The asset has no open assignment to close.');
  }

  const now = new Date();
  await runInTransaction(async (tx) => {
    await closeOpenAssignment(asset.id, now, input.notes ?? null, tx);
    await updateAsset(
      asset.id,
      { state: 'IN_STOCK', assignedToUserId: null, assignedToTeamId: null },
      tx,
    );
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_RETURN,
        entityType: AUDIT_ENTITY.ASSET,
        entityId: asset.id,
        before: { state: asset.state, assignedToUserId: asset.assignedToUserId },
        after: { state: 'IN_STOCK', assignedToUserId: null, assignedToTeamId: null },
        reason: input.notes ?? null,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return getAsset(asset.id, actor);
}

/** Moves an asset into repair; an open assignment is closed in the same operation. */
export async function markAssetInRepair(
  id: string,
  input: { reason?: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetView> {
  const asset = await loadManageable(id, actor);
  if (RETIRED_STATES.includes(asset.state)) {
    throw new ConflictError('A retired or disposed asset cannot be repaired.');
  }
  if (asset.state === 'IN_REPAIR') {
    throw new ConflictError('The asset is already in repair.');
  }

  const now = new Date();
  await runInTransaction(async (tx) => {
    if (asset.assignedToUserId || asset.assignedToTeamId) {
      await closeOpenAssignment(asset.id, now, input.reason ?? null, tx);
    }
    await updateAsset(
      asset.id,
      { state: 'IN_REPAIR', assignedToUserId: null, assignedToTeamId: null },
      tx,
    );
    await writeAudit(
      {
        organizationId: asset.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_UPDATE,
        entityType: AUDIT_ENTITY.ASSET,
        entityId: asset.id,
        before: { state: asset.state },
        after: { state: 'IN_REPAIR' },
        reason: input.reason ?? null,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return getAsset(asset.id, actor);
}

/**
 * Retires an asset (AM4/AM5): any open assignment is closed in the same operation and the
 * record becomes read-only. Never a delete — request history may reference it.
 */
export async function retireAsset(
  id: string,
  input: { reason?: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetView> {
  const asset = await loadManageable(id, actor);
  if (asset.state === 'RETIRED' || asset.state === 'DISPOSED') {
    throw new ConflictError('The asset is already retired or disposed.');
  }

  const now = new Date();
  await runInTransaction(async (tx) => {
    if (asset.assignedToUserId || asset.assignedToTeamId) {
      await closeOpenAssignment(asset.id, now, input.reason ?? null, tx);
    }
    await updateAsset(
      asset.id,
      {
        state: 'RETIRED',
        retiredAt: now,
        assignedToUserId: null,
        assignedToTeamId: null,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: asset.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_RETIRE,
        entityType: AUDIT_ENTITY.ASSET,
        entityId: asset.id,
        before: { state: asset.state },
        after: { state: 'RETIRED' },
        reason: input.reason ?? null,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return getAsset(asset.id, actor);
}

/** Disposes a retired asset — terminal, retained for history (docs/28 §4). */
export async function disposeAsset(
  id: string,
  input: { reason?: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<AssetView> {
  const asset = await loadManageable(id, actor);
  if (asset.state !== 'RETIRED') {
    throw new ConflictError('Only a retired asset can be disposed.');
  }

  const now = new Date();
  await runInTransaction(async (tx) => {
    await updateAsset(asset.id, { state: 'DISPOSED', disposedAt: now }, tx);
    await writeAudit(
      {
        organizationId: asset.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ASSET_DISPOSE,
        entityType: AUDIT_ENTITY.ASSET,
        entityId: asset.id,
        before: { state: asset.state },
        after: { state: 'DISPOSED' },
        reason: input.reason ?? null,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return getAsset(asset.id, actor);
}

/** The full interval history — including the open interval, if any (`docs/28` §8). */
export async function listAssetAssignments(
  id: string,
  actor: Principal,
): Promise<AssetView['assignments']> {
  const asset = await loadReadable(id, actor);
  const rows = await listAssignments(asset.id);
  return rows.map((row) => ({
    id: row.id,
    holderType: row.holderType,
    userId: row.userId,
    teamId: row.teamId,
    assignedAt: row.assignedAt,
    returnedAt: row.returnedAt,
    assignedById: row.assignedById,
    notes: row.notes,
  }));
}
