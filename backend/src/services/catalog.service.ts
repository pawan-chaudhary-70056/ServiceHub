import type { CatalogItem, Category, Prisma, SlaPolicy } from '@prisma/client';
import { assertPermission, hasPermission, type Principal } from '../helpers/authorization';
import { ValidationError, DuplicateError, ForbiddenError, NotFoundError } from '../utils/errors';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  countActiveItemsByCategory,
  createCatalogItem,
  createCategory as dbCreateCategory,
  findCatalogItemById,
  findCatalogItemByName,
  findCategoryById,
  findCategoryByParentAndName,
  findSlaPolicyById,
  findTeamById,
  listActiveCatalogItems,
  listCatalogItems,
  listCategories,
  replaceCatalogItemFields,
  runInTransaction,
  updateCatalogItem,
  updateCategory as dbUpdateCategory,
  writeAudit,
  type CatalogFieldInput as CatalogFieldWrite,
  type CatalogItemListRow,
  type CatalogItemWithFields,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import {
  catalogRegionTtlSeconds,
  invalidateCatalogCache,
  readCatalogRegion,
} from './catalog-cache';
import type { RequestMeta } from './context';

/**
 * Service catalog — docs/21, F-04.
 *
 * The catalog is the **intake contract**: every rule here exists so downstream work is
 * measurable and routable. The two rules that shape most of this module:
 *
 *   - **C1:** an item cannot be activated without a category, an SLA policy and a
 *     fulfilment team — otherwise it produces unmeasurable, unowned work.
 *   - **C3/C5/C6:** definitions are frozen into a request at creation, and retiring an
 *     item never mutates existing requests. That is why retirement is a status change
 *     here and never a delete.
 *
 * Authorization is checked twice, as docs/07 §6 requires: the route's coarse permission
 * check, then the authoritative tenant/object check in these methods. A caller from
 * another tenant receives NOT_FOUND, never FORBIDDEN, so the API does not disclose that
 * the record exists (docs/17).
 */

const READ_PERMISSION = 'catalog:read';
const MANAGE_PERMISSION = 'catalog:manage';

export interface CategoryView {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  itemCount: number;
}

export interface CatalogItemSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  defaultPriority: string;
  requiresApproval: boolean;
  categoryId: string;
  categoryName: string;
  defaultSlaPolicyId: string | null;
  fulfilmentTeamId: string | null;
  createdAt: Date;
}

export interface CatalogItemDetail extends CatalogItemSummary {
  defaultSlaPolicy: { id: string; name: string } | null;
  fulfilmentTeam: { id: string; name: string } | null;
  fields: Array<{
    id: string;
    key: string;
    label: string;
    fieldType: string;
    isRequired: boolean;
    options: unknown;
    validation: unknown;
    helpText: string | null;
    displayOrder: number;
  }>;
}

export interface CatalogFieldInput {
  key: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  options?: string[];
  validation?: Record<string, unknown>;
  helpText?: string;
  displayOrder: number;
}

export interface CatalogItemInput {
  categoryId: string;
  name: string;
  description: string | null;
  defaultPriority: CatalogItem['defaultPriority'];
  defaultSlaPolicyId: string | null;
  fulfilmentTeamId: string | null;
  requiresApproval: boolean;
  fields?: CatalogFieldInput[];
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * The category tree, flattened with parent references (docs/21 §9). The client rebuilds
 * the tree; returning it flat keeps the payload stable and lets a deep link address a
 * category without walking a nested structure.
 *
 * The `includeInactive` flag is honoured **only for a manager**: a requester's view must
 * never contain a deactivated category (docs/21 §4).
 */
export async function listCategoryTree(
  actor: Principal,
  input: { includeInactive: boolean },
): Promise<CategoryView[]> {
  assertPermission(actor, READ_PERMISSION);
  const organizationId = requireTenant(actor);

  const canManage = hasPermission(actor, MANAGE_PERMISSION);
  const includeInactive = input.includeInactive && canManage;

  // The region caches the tree **unfiltered** and the viewer's filter is applied after
  // the read (`docs/21` §10, rule C1): one shared entry per tenant that cannot leak an
  // inactive category to a requester, because what differs between viewers was never
  // part of what was cached. The item counts are part of the tree — an item activation
  // moves them — so they load inside the same region and are invalidated with it.
  const payload = await readCatalogRegion({
    region: 'catalog.categories',
    organizationId,
    viewKey: 'tree',
    ttlSeconds: catalogRegionTtlSeconds('catalog.categories'),
    load: async () => {
      const [categories, counts] = await Promise.all([
        listCategories(organizationId, { includeInactive: true }),
        countActiveItemsByCategory(organizationId),
      ]);
      return JSON.stringify({ categories, counts: [...counts] });
    },
  });

  const cached = JSON.parse(payload) as {
    categories: Array<Omit<Category, 'createdAt' | 'updatedAt'> & { createdAt: string }>;
    counts: Array<[string, number]>;
  };
  const counts = new Map(cached.counts);

  return cached.categories
    .filter((category) => includeInactive || category.isActive)
    .map((category) => ({
      id: category.id,
      name: category.name,
      parentId: category.parentId,
      description: category.description,
      displayOrder: category.displayOrder,
      isActive: category.isActive,
      itemCount: counts.get(category.id) ?? 0,
    }));
}

export async function createCategory(
  input: {
    name: string;
    parentId: string | null;
    description: string | null;
    displayOrder: number;
  },
  actor: Principal,
  meta: RequestMeta,
): Promise<Category> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  if (input.parentId) {
    await requireParentCategory(input.parentId, organizationId);
    await assertCategoryDepth(input.parentId);
  }

  if (await findCategoryByParentAndName(organizationId, input.parentId, input.name)) {
    throw new DuplicateError('A category with that name already exists here.');
  }

  return runInTransaction(async (tx) => {
    const category = await dbCreateCategory(
      {
        organizationId,
        parentId: input.parentId,
        name: input.name,
        description: input.description,
        displayOrder: input.displayOrder,
      },
      tx,
    );

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.CATEGORY_CREATE,
        entityType: AUDIT_ENTITY.CATEGORY,
        entityId: category.id,
        after: { name: category.name, parentId: category.parentId },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return category;
  }).then(async (category) => {
    // Invalidation runs *after* the commit (C3): doing it inside would let a concurrent
    // reader repopulate the region from pre-commit data and stay stale until its TTL.
    await invalidateCatalogCache(organizationId);
    return category;
  });
}

export async function updateCategory(
  id: string,
  input: {
    name?: string;
    parentId?: string | null;
    description?: string | null;
    displayOrder?: number;
    isActive?: boolean;
  },
  actor: Principal,
  meta: RequestMeta,
): Promise<Category> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  const existing = await findCategoryById(id);
  if (!existing || existing.organizationId !== organizationId) {
    throw new NotFoundError('Category not found.');
  }

  if (input.parentId !== undefined && input.parentId !== null) {
    await requireParentCategory(input.parentId, organizationId);
    // Prevent a move that would create a cycle or exceed the three-level bound (C7).
    await assertNotDescendant(id, input.parentId);
    await assertCategoryDepth(input.parentId);
  }

  if (input.name !== undefined || input.parentId !== undefined) {
    const parentId = input.parentId === undefined ? existing.parentId : input.parentId;
    const name = input.name ?? existing.name;
    const clash = await findCategoryByParentAndName(organizationId, parentId, name);
    if (clash && clash.id !== id) {
      throw new DuplicateError('A category with that name already exists here.');
    }
  }

  return runInTransaction(async (tx) => {
    const updated = await dbUpdateCategory(id, input, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.CATEGORY_UPDATE,
        entityType: AUDIT_ENTITY.CATEGORY,
        entityId: id,
        before: { name: existing.name, parentId: existing.parentId, isActive: existing.isActive },
        after: input as Prisma.InputJsonValue,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return updated;
  }).then(async (updated) => {
    // A rename lands in list rows too (`categoryName`), so both regions move (C3).
    await invalidateCatalogCache(organizationId);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Catalog items
// ---------------------------------------------------------------------------

export async function listItems(
  input: { limit: number; cursor?: string; status?: string; categoryId?: string },
  actor: Principal,
): Promise<CursorPage<CatalogItemSummary>> {
  assertPermission(actor, READ_PERMISSION);
  const organizationId = requireTenant(actor);
  const canManage = hasPermission(actor, MANAGE_PERMISSION);

  // C1 by key rather than by filter: a requester's page and a manager's page of the
  // same filters are different views (status filtering differs), so the viewer class is
  // part of the key. A shared key here is the classic cache authz leak — it would serve
  // a manager's draft rows to a requester. Cursor pages are cached individually; the
  // invalidation is per-region, so any catalog write retires every page at once.
  const viewKey = [
    canManage ? 'manager' : 'requester',
    canManage ? (input.status ?? 'ANY') : 'ACTIVE',
    input.categoryId ?? 'ANY',
    String(input.limit),
    input.cursor ?? 'FIRST',
  ].join('|');

  const payload = await readCatalogRegion({
    region: 'catalog.items',
    organizationId,
    viewKey,
    ttlSeconds: catalogRegionTtlSeconds('catalog.items'),
    load: async () => {
      const rows = canManage
        ? await listCatalogItems({
            organizationId,
            status: input.status as CatalogItem['status'] | undefined,
            categoryId: input.categoryId,
            limit: input.limit,
            cursor: input.cursor,
          })
        : await listActiveCatalogItems({
            organizationId,
            categoryId: input.categoryId,
            limit: input.limit,
            cursor: input.cursor,
          });
      const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);
      return JSON.stringify({ ...page, items: page.items.map(toSummary) });
    },
  });

  // The cached and a fresh payload are the same serialised shape by construction: the
  // loader builds exactly the object a cache miss would have returned, and `createdAt`
  // crosses every HTTP boundary as the same ISO string either way.
  return JSON.parse(payload) as CursorPage<CatalogItemSummary>;
}

export async function getItem(id: string, actor: Principal): Promise<CatalogItemDetail> {
  assertPermission(actor, READ_PERMISSION);
  const organizationId = requireTenant(actor);

  const item = await findCatalogItemById(id);
  if (!item || item.organizationId !== organizationId) {
    throw new NotFoundError('Catalog item not found.');
  }

  // A requester cannot see a draft or retired item — indistinguishable from absence.
  if (item.status !== 'ACTIVE' && !hasPermission(actor, MANAGE_PERMISSION)) {
    throw new NotFoundError('Catalog item not found.');
  }

  return toDetail(item);
}

export async function createItem(
  input: CatalogItemInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<CatalogItemDetail> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  await assertReferences(organizationId, input);
  if (await findCatalogItemByName(organizationId, input.categoryId, input.name)) {
    throw new DuplicateError('An item with that name already exists in this category.');
  }

  const item = await runInTransaction(async (tx) => {
    const created = await createCatalogItem(
      {
        organizationId,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        defaultPriority: input.defaultPriority,
        defaultSlaPolicyId: input.defaultSlaPolicyId,
        fulfilmentTeamId: input.fulfilmentTeamId,
        requiresApproval: input.requiresApproval,
      },
      tx,
    );

    if (input.fields && input.fields.length > 0) {
      await replaceCatalogItemFields(created.id, toFieldWrites(input.fields), tx);
    }

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.CATALOG_ITEM_CREATE,
        entityType: AUDIT_ENTITY.CATALOG_ITEM,
        entityId: created.id,
        after: { name: created.name, categoryId: created.categoryId },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return created;
  });

  await invalidateCatalogCache(organizationId);

  return toDetail((await findCatalogItemById(item.id)) as CatalogItemWithFields);
}

export async function updateItem(
  id: string,
  input: Partial<CatalogItemInput>,
  actor: Principal,
  meta: RequestMeta,
): Promise<CatalogItemDetail> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  const existing = await findCatalogItemById(id);
  if (!existing || existing.organizationId !== organizationId) {
    throw new NotFoundError('Catalog item not found.');
  }

  await assertReferences(organizationId, {
    categoryId: input.categoryId ?? existing.categoryId,
    defaultSlaPolicyId:
      input.defaultSlaPolicyId === undefined
        ? existing.defaultSlaPolicyId
        : input.defaultSlaPolicyId,
    fulfilmentTeamId:
      input.fulfilmentTeamId === undefined ? existing.fulfilmentTeamId : input.fulfilmentTeamId,
  });

  await runInTransaction(async (tx) => {
    await updateCatalogItem(
      id,
      {
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.defaultPriority !== undefined ? { defaultPriority: input.defaultPriority } : {}),
        ...(input.defaultSlaPolicyId !== undefined
          ? { defaultSlaPolicyId: input.defaultSlaPolicyId }
          : {}),
        ...(input.fulfilmentTeamId !== undefined
          ? { fulfilmentTeamId: input.fulfilmentTeamId }
          : {}),
        ...(input.requiresApproval !== undefined
          ? { requiresApproval: input.requiresApproval }
          : {}),
      },
      tx,
    );

    if (input.fields) {
      await replaceCatalogItemFields(id, toFieldWrites(input.fields), tx);
    }

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.CATALOG_ITEM_UPDATE,
        entityType: AUDIT_ENTITY.CATALOG_ITEM,
        entityId: id,
        before: { name: existing.name, categoryId: existing.categoryId },
        after: { name: input.name ?? existing.name },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  await invalidateCatalogCache(organizationId);

  return toDetail((await findCatalogItemById(id)) as CatalogItemWithFields);
}

/**
 * Activates an item — the guard is rule C1 (docs/21 §5): a name, a category, an SLA
 * policy and a fulfilment team. Without all four the item produces unmeasurable,
 * unowned work, so activation fails loudly rather than allowing it.
 */
export async function activateItem(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<CatalogItemDetail> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  const item = await findCatalogItemById(id);
  if (!item || item.organizationId !== organizationId) {
    throw new NotFoundError('Catalog item not found.');
  }

  const missing: string[] = [];
  if (!item.defaultSlaPolicyId) missing.push('SLA policy');
  if (!item.fulfilmentTeamId) missing.push('fulfilment team');
  if (missing.length > 0) {
    throw new ValidationError(
      missing.map((label) => ({
        field: label === 'SLA policy' ? 'defaultSlaPolicyId' : 'fulfilmentTeamId',
        code: 'REQUIRED_FOR_ACTIVATION',
        message: `An item cannot be activated without a ${label}.`,
      })),
    );
  }

  await changeItemStatus(id, 'ACTIVE', AUDIT_ACTION.CATALOG_ITEM_ACTIVATE, actor, meta);
  return toDetail((await findCatalogItemById(id)) as CatalogItemWithFields);
}

/** Retirement is a status change, never a delete (C5): existing requests stay readable. */
export async function retireItem(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<CatalogItemDetail> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  const item = await findCatalogItemById(id);
  if (!item || item.organizationId !== organizationId) {
    throw new NotFoundError('Catalog item not found.');
  }

  await changeItemStatus(id, 'RETIRED', AUDIT_ACTION.CATALOG_ITEM_RETIRE, actor, meta);
  return toDetail((await findCatalogItemById(id)) as CatalogItemWithFields);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can use the catalog.');
  }
  return actor.organizationId;
}

/**
 * Converts validated field inputs into the data-access write shape.
 *
 * The validator deals in plain JSON (`string[]`, `Record<string, unknown>`) while Prisma's
 * JSON columns want `InputJsonValue`; this is the single boundary where that difference is
 * reconciled, so it is not spread through the service logic.
 */
function toFieldWrites(fields: CatalogFieldInput[]): CatalogFieldWrite[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    fieldType: field.fieldType as CatalogFieldWrite['fieldType'],
    isRequired: field.isRequired,
    options: (field.options ?? null) as CatalogFieldWrite['options'],
    validation: (field.validation ?? null) as CatalogFieldWrite['validation'],
    helpText: field.helpText ?? null,
    displayOrder: field.displayOrder,
  }));
}

async function requireParentCategory(parentId: string, organizationId: string): Promise<void> {
  const parent = await findCategoryById(parentId);
  if (!parent || parent.organizationId !== organizationId) {
    throw new NotFoundError('Parent category not found.');
  }
}

/** Rule C7: categories may not nest beyond three levels. */
async function assertCategoryDepth(parentId: string): Promise<void> {
  let depth = 1;
  let current: string | null = parentId;
  for (let i = 0; current && i < 10; i += 1) {
    const node = await findCategoryById(current);
    if (!node) break;
    depth += 1;
    current = node.parentId;
  }
  if (depth > 3) {
    throw new ValidationError([
      {
        field: 'parentId',
        code: 'MAX_DEPTH',
        message: 'Categories cannot nest beyond three levels.',
      },
    ]);
  }
}

/** Prevents a category being moved under one of its own descendants (cycle). */
async function assertNotDescendant(ancestorId: string, candidateParentId: string): Promise<void> {
  let current: string | null = candidateParentId;
  for (let i = 0; current && i < 10; i += 1) {
    if (current === ancestorId) {
      throw new ValidationError([
        { field: 'parentId', code: 'CYCLE', message: 'A category cannot be moved under itself.' },
      ]);
    }
    const node = await findCategoryById(current);
    current = node?.parentId ?? null;
  }
}

/**
 * Validates that the item's reference fields belong to the caller's tenant.
 *
 * A cross-tenant reference is refused as NOT_FOUND, the same as a missing one, so a
 * client cannot use the error to enumerate another tenant's ids (docs/17).
 */
async function assertReferences(
  organizationId: string,
  refs: {
    categoryId?: string;
    defaultSlaPolicyId?: string | null;
    fulfilmentTeamId?: string | null;
  },
): Promise<void> {
  if (refs.categoryId) {
    const category = await findCategoryById(refs.categoryId);
    if (!category || category.organizationId !== organizationId) {
      throw new NotFoundError('Category not found.');
    }
  }

  const slaPolicy: SlaPolicy | null = refs.defaultSlaPolicyId
    ? await findSlaPolicyById(refs.defaultSlaPolicyId)
    : null;
  if (refs.defaultSlaPolicyId && (!slaPolicy || slaPolicy.organizationId !== organizationId)) {
    throw new NotFoundError('SLA policy not found.');
  }

  if (refs.fulfilmentTeamId) {
    const team = await findTeamById(refs.fulfilmentTeamId);
    if (!team || team.organizationId !== organizationId) {
      throw new NotFoundError('Fulfilment team not found.');
    }
  }
}

async function changeItemStatus(
  id: string,
  status: CatalogItem['status'],
  action: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<void> {
  await runInTransaction(async (tx) => {
    const before = await findCatalogItemById(id, tx);
    await updateCatalogItem(id, { status }, tx);
    await writeAudit(
      {
        organizationId: actor.organizationId as string,
        actorId: actor.userId,
        actorType: 'USER',
        action,
        entityType: AUDIT_ENTITY.CATALOG_ITEM,
        entityId: id,
        before: { status: before?.status },
        after: { status },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  // Status moves between the active list and the requester's catalog (C4).
  await invalidateCatalogCache(actor.organizationId as string);
}

function toSummary(row: CatalogItemListRow | CatalogItem): CatalogItemSummary {
  const category = 'category' in row ? row.category : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    defaultPriority: row.defaultPriority,
    requiresApproval: row.requiresApproval,
    categoryId: row.categoryId,
    categoryName: category?.name ?? '',
    defaultSlaPolicyId: row.defaultSlaPolicyId,
    fulfilmentTeamId: row.fulfilmentTeamId,
    createdAt: row.createdAt,
  };
}

/**
 * Full detail, including the referenced SLA policy and fulfilment team names. The ids
 * are opaque and their tenant membership was validated on write; the names are included
 * so an administrator can read an item without a second request per reference.
 */
function toDetail(item: CatalogItemWithFields): CatalogItemDetail {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    status: item.status,
    defaultPriority: item.defaultPriority,
    requiresApproval: item.requiresApproval,
    categoryId: item.categoryId,
    categoryName: item.category.name,
    defaultSlaPolicyId: item.defaultSlaPolicyId,
    fulfilmentTeamId: item.fulfilmentTeamId,
    createdAt: item.createdAt,
    defaultSlaPolicy: item.defaultSlaPolicy,
    fulfilmentTeam: item.fulfilmentTeam,
    fields: item.fields.map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      fieldType: field.fieldType,
      isRequired: field.isRequired,
      options: field.options,
      validation: field.validation,
      helpText: field.helpText,
      displayOrder: field.displayOrder,
    })),
  };
}
