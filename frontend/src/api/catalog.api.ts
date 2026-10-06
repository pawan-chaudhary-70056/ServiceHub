import { apiRequest } from './client';

/**
 * Service catalog API (docs/21 §8, docs/11 §9).
 *
 * The server enforces every rule; this module only shapes requests and types responses.
 * Two rules the UI must respect because they are visible to a reader:
 *   - a retired or draft item is not requestable and is invisible to a requester (`21` §4);
 *   - a field definition is frozen into a request at creation, so editing an item never
 *     rewrites past answers (`21` §5 C3).
 */

export type CatalogItemStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type CatalogFieldType =
  | 'TEXT'
  | 'LONG_TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'DATETIME'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'BOOLEAN'
  | 'FILE'
  | 'USER';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CategoryView {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  itemCount: number;
}

export interface CatalogItemField {
  id: string;
  key: string;
  label: string;
  fieldType: CatalogFieldType;
  isRequired: boolean;
  options: unknown;
  validation: unknown;
  helpText: string | null;
  displayOrder: number;
}

export interface CatalogItemSummary {
  id: string;
  name: string;
  description: string | null;
  status: CatalogItemStatus;
  defaultPriority: Priority;
  requiresApproval: boolean;
  categoryId: string;
  categoryName: string;
  defaultSlaPolicyId: string | null;
  fulfilmentTeamId: string | null;
  createdAt: string;
}

export interface CatalogItemDetail extends CatalogItemSummary {
  defaultSlaPolicy: { id: string; name: string } | null;
  fulfilmentTeam: { id: string; name: string } | null;
  fields: CatalogItemField[];
}

export interface CatalogFieldInput {
  key: string;
  label: string;
  fieldType: CatalogFieldType;
  isRequired?: boolean;
  options?: string[];
  helpText?: string;
  displayOrder?: number;
}

export interface CreateCatalogItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  defaultPriority?: Priority;
  defaultSlaPolicyId?: string | null;
  fulfilmentTeamId?: string | null;
  requiresApproval?: boolean;
  fields?: CatalogFieldInput[];
}

export type UpdateCatalogItemInput = Partial<CreateCatalogItemInput>;

export function listCategories(
  params: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ items: CategoryView[] }> {
  const query = new URLSearchParams();
  if (params.includeInactive) query.set('includeInactive', 'true');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<{ items: CategoryView[] }>(`/catalog/categories${suffix}`, { signal });
}

export function createCategory(input: {
  name: string;
  parentId?: string | null;
  description?: string | null;
  displayOrder?: number;
}): Promise<{ category: CategoryView }> {
  return apiRequest<{ category: CategoryView }>('/catalog/categories', {
    method: 'POST',
    body: input,
  });
}

export function listItems(
  params: { cursor?: string; limit?: number; status?: CatalogItemStatus; categoryId?: string } = {},
  signal?: AbortSignal,
): Promise<CursorPage<CatalogItemSummary>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  if (params.categoryId) query.set('categoryId', params.categoryId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<CursorPage<CatalogItemSummary>>(`/catalog/items${suffix}`, { signal });
}

export function getItem(id: string, signal?: AbortSignal): Promise<{ item: CatalogItemDetail }> {
  return apiRequest<{ item: CatalogItemDetail }>(`/catalog/items/${id}`, { signal });
}

export function createItem(input: CreateCatalogItemInput): Promise<{ item: CatalogItemDetail }> {
  return apiRequest<{ item: CatalogItemDetail }>('/catalog/items', { method: 'POST', body: input });
}

export function updateItem(
  id: string,
  input: UpdateCatalogItemInput,
): Promise<{ item: CatalogItemDetail }> {
  return apiRequest<{ item: CatalogItemDetail }>(`/catalog/items/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function activateItem(id: string): Promise<{ item: CatalogItemDetail }> {
  return apiRequest<{ item: CatalogItemDetail }>(`/catalog/items/${id}/activate`, {
    method: 'POST',
  });
}

export function retireItem(id: string): Promise<{ item: CatalogItemDetail }> {
  return apiRequest<{ item: CatalogItemDetail }>(`/catalog/items/${id}/retire`, { method: 'POST' });
}
