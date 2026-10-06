import type {
  CatalogFieldType,
  CatalogItem,
  CatalogItemField,
  CatalogItemStatus,
  Category,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * Service catalog data access — docs/21, F-04.
 *
 * The catalog is the intake contract: a request is derived from a catalog item, so the
 * queries here must return exactly the definitions a request is built from. Two rules
 * shape the shape of this module:
 *
 *   - **C3 / C5:** a retired item is invisible to requesters but its history stays
 *     readable. That is a status filter, never a delete.
 *   - **C2:** a field `key` is immutable after first use, so writes upsert by key and
 *     remove only keys the caller dropped, rather than recreating rows.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

/** A category plus its children, as returned to the browse tree. */
export interface CategoryNode extends Category {
  itemCount: number;
}

export interface CatalogItemWithFields extends CatalogItem {
  fields: CatalogItemField[];
  category: Pick<Category, 'id' | 'name' | 'parentId'>;
  defaultSlaPolicy: { id: string; name: string } | null;
  fulfilmentTeam: { id: string; name: string } | null;
}

export interface CatalogItemListRow extends CatalogItem {
  category: Pick<Category, 'id' | 'name' | 'parentId'>;
}

/** Fields as supplied by a manage caller. `id` is absent for a new field. */
export interface CatalogFieldInput {
  key: string;
  label: string;
  fieldType: CatalogFieldType;
  isRequired: boolean;
  options?: Prisma.InputJsonValue | null;
  validation?: Prisma.InputJsonValue | null;
  helpText?: string | null;
  displayOrder: number;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function listCategories(
  organizationId: string,
  params: { includeInactive: boolean },
  client: DataClient = prisma,
): Promise<Category[]> {
  return client.category.findMany({
    where: {
      organizationId,
      ...(params.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });
}

/** Item counts per category, used so the browse tree can show what is requestable. */
export async function countActiveItemsByCategory(
  organizationId: string,
  client: DataClient = prisma,
): Promise<Map<string, number>> {
  const rows = await client.catalogItem.groupBy({
    by: ['categoryId'],
    where: { organizationId, status: 'ACTIVE' },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.categoryId, row._count._all]));
}

export function findCategoryById(
  id: string,
  client: DataClient = prisma,
): Promise<Category | null> {
  return client.category.findUnique({ where: { id } });
}

export function findCategoryByParentAndName(
  organizationId: string,
  parentId: string | null,
  name: string,
  client: DataClient = prisma,
): Promise<Category | null> {
  // The unique index is `(organizationId, parentId, name)`; Prisma cannot address a
  // compound unique with a nullable member, so this is an explicit findFirst.
  return client.category.findFirst({ where: { organizationId, parentId, name } });
}

export function createCategory(
  data: {
    organizationId: string;
    parentId: string | null;
    name: string;
    description: string | null;
    displayOrder: number;
  },
  client: DataClient = prisma,
): Promise<Category> {
  return client.category.create({ data });
}

export function updateCategory(
  id: string,
  data: Partial<{
    name: string;
    description: string | null;
    displayOrder: number;
    isActive: boolean;
  }>,
  client: DataClient = prisma,
): Promise<Category> {
  return client.category.update({ where: { id }, data });
}

export function countItemsInCategory(
  categoryId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.catalogItem.count({ where: { categoryId } });
}

/** Child categories, used to block deleting/moving a category that still has children. */
export function listChildCategories(
  categoryId: string,
  client: DataClient = prisma,
): Promise<Category[]> {
  return client.category.findMany({ where: { parentId: categoryId } });
}

// ---------------------------------------------------------------------------
// Catalog items
// ---------------------------------------------------------------------------

/**
 * Lists items for management, newest-first, cursor-paginated (docs/11 §6). Fetches
 * `limit + 1` rows so `hasMore` needs no second count query.
 */
export function listCatalogItems(
  params: {
    organizationId: string;
    status?: CatalogItemStatus;
    categoryId?: string;
    limit: number;
    cursor?: string;
  },
  client: DataClient = prisma,
): Promise<CatalogItemListRow[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  return client.catalogItem.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params.cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(sortValue) } },
              { createdAt: new Date(sortValue), id: { lt: id } },
            ],
          }
        : {}),
    },
    include: { category: { select: { id: true, name: true, parentId: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });
}

/** Items visible to a requester: ACTIVE only (docs/21 §4, rule C5). */
export function listActiveCatalogItems(
  params: { organizationId: string; categoryId?: string; limit: number; cursor?: string },
  client: DataClient = prisma,
): Promise<CatalogItemListRow[]> {
  return listCatalogItems({ ...params, status: 'ACTIVE' }, client);
}

export function findCatalogItemById(
  id: string,
  client: DataClient = prisma,
): Promise<CatalogItemWithFields | null> {
  return client.catalogItem.findUnique({
    where: { id },
    include: {
      fields: { orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }] },
      category: { select: { id: true, name: true, parentId: true } },
      defaultSlaPolicy: { select: { id: true, name: true } },
      fulfilmentTeam: { select: { id: true, name: true } },
    },
  });
}

export function findCatalogItemByName(
  organizationId: string,
  categoryId: string,
  name: string,
  client: DataClient = prisma,
): Promise<CatalogItem | null> {
  return client.catalogItem.findFirst({ where: { organizationId, categoryId, name } });
}

export function createCatalogItem(
  data: {
    organizationId: string;
    categoryId: string;
    name: string;
    description: string | null;
    defaultPriority: CatalogItem['defaultPriority'];
    defaultSlaPolicyId: string | null;
    fulfilmentTeamId: string | null;
    requiresApproval: boolean;
  },
  client: DataClient = prisma,
): Promise<CatalogItem> {
  return client.catalogItem.create({ data });
}

export function updateCatalogItem(
  id: string,
  data: Partial<{
    categoryId: string;
    name: string;
    description: string | null;
    defaultPriority: CatalogItem['defaultPriority'];
    defaultSlaPolicyId: string | null;
    fulfilmentTeamId: string | null;
    requiresApproval: boolean;
    status: CatalogItemStatus;
  }>,
  client: DataClient = prisma,
): Promise<CatalogItem> {
  return client.catalogItem.update({ where: { id }, data });
}

// ---------------------------------------------------------------------------
// Item fields
// ---------------------------------------------------------------------------

/**
 * Applies a full field set to an item.
 *
 * Existing keys are updated in place (rule C2: a key is immutable after first use, so a
 * caller that keeps the key is editing the same field); keys absent from the payload are
 * deleted. Deletion is safe only while no request snapshot references them, which the
 * service checks before calling this (rule C9).
 */
export async function replaceCatalogItemFields(
  catalogItemId: string,
  fields: CatalogFieldInput[],
  client: DataClient,
): Promise<void> {
  const existing = await client.catalogItemField.findMany({ where: { catalogItemId } });
  const keep = new Set(fields.map((field) => field.key));
  const removed = existing.filter((field) => !keep.has(field.key));

  if (removed.length > 0) {
    await client.catalogItemField.deleteMany({
      where: { id: { in: removed.map((field) => field.id) } },
    });
  }

  for (const field of fields) {
    await client.catalogItemField.upsert({
      where: { catalogItemId_key: { catalogItemId, key: field.key } },
      update: {
        label: field.label,
        isRequired: field.isRequired,
        options: field.options ?? undefined,
        validation: field.validation ?? undefined,
        helpText: field.helpText ?? null,
        displayOrder: field.displayOrder,
        // fieldType is intentionally NOT updated when the key already exists: a field's
        // stored values are typed, so changing its type under existing data would make
        // them unreadable (docs/21 §3, rule C2). A type change is a new key.
      },
      create: {
        catalogItemId,
        key: field.key,
        label: field.label,
        fieldType: field.fieldType,
        isRequired: field.isRequired,
        options: field.options ?? undefined,
        validation: field.validation ?? undefined,
        helpText: field.helpText ?? null,
        displayOrder: field.displayOrder,
      },
    });
  }
}
