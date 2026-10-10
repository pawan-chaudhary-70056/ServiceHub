import { apiRequest } from './client';
import type { CursorPage } from './tasks.api';

/**
 * Asset register API (docs/28 §8, docs/11 §9).
 *
 * The service owns the holder scope and the lifecycle invariants: `state` and the open
 * assignment can never disagree (rule AM6), and a caller who may not read an asset
 * receives `404`, not `403`. The UI therefore never derives a holder from `state` — it
 * reads the `holder` the server returned.
 */

export type AssetState =
  'PROCURED' | 'IN_STOCK' | 'ASSIGNED' | 'IN_REPAIR' | 'RETIRED' | 'DISPOSED';

export type AssetHolderType = 'USER' | 'TEAM';

export interface AssetHolder {
  type: AssetHolderType | null;
  user: { id: string; displayName: string; email: string } | null;
  team: { id: string; name: string } | null;
}

export interface AssetAssignmentView {
  id: string;
  holderType: AssetHolderType;
  userId: string | null;
  teamId: string | null;
  assignedAt: string;
  returnedAt: string | null;
  assignedById: string;
  notes: string | null;
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
    assignedAt: string;
    assignedById: string;
    notes: string | null;
  } | null;
  assignments: AssetAssignmentView[];
  purchaseDate: string | null;
  warrantyExpiresAt: string | null;
  /** Derived by the server from `warrantyExpiresAt`, never stored (rule AM9). */
  warrantyExpired: boolean;
  retiredAt: string | null;
  disposedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetListItem {
  id: string;
  tag: string;
  serialNumber: string | null;
  name: string;
  state: AssetState;
  assetType: { id: string; key: string; name: string };
  holder: AssetHolder;
  warrantyExpiresAt: string | null;
  createdAt: string;
}

export interface AssetTypeView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  attributeSchema: { required?: string[] } & Record<string, unknown>;
  isActive: boolean;
}

export interface CreateAssetInput {
  assetTypeId: string;
  name: string;
  description?: string | null;
  serialNumber?: string | null;
  state?: 'PROCURED' | 'IN_STOCK';
  attributes?: Record<string, unknown>;
  purchaseDate?: string | null;
  warrantyExpiresAt?: string | null;
}

export function listAssets(
  params: {
    cursor?: string;
    limit?: number;
    state?: AssetState;
    assetTypeId?: string;
    holderUserId?: string;
  } = {},
  signal?: AbortSignal,
): Promise<CursorPage<AssetListItem>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.state) query.set('state', params.state);
  if (params.assetTypeId) query.set('assetTypeId', params.assetTypeId);
  if (params.holderUserId) query.set('holderUserId', params.holderUserId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<CursorPage<AssetListItem>>(`/assets${suffix}`, { signal });
}

/** Accepts the opaque id or the human-readable `AST-000123` tag. */
export function getAsset(idOrTag: string, signal?: AbortSignal): Promise<{ asset: AssetView }> {
  return apiRequest<{ asset: AssetView }>(`/assets/${encodeURIComponent(idOrTag)}`, { signal });
}

export function createAsset(input: CreateAssetInput): Promise<{ asset: AssetView }> {
  return apiRequest<{ asset: AssetView }>('/assets', { method: 'POST', body: input });
}

export function updateAsset(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    serialNumber?: string | null;
    attributes?: Record<string, unknown>;
    state?: 'PROCURED' | 'IN_STOCK' | 'IN_REPAIR';
    purchaseDate?: string | null;
    warrantyExpiresAt?: string | null;
  },
): Promise<{ asset: AssetView }> {
  return apiRequest<{ asset: AssetView }>(`/assets/${id}`, { method: 'PATCH', body: input });
}

export function assignAsset(
  id: string,
  input: {
    holderType: AssetHolderType;
    userId?: string | null;
    teamId?: string | null;
    notes?: string | null;
  },
): Promise<{ asset: AssetView }> {
  return apiRequest<{ asset: AssetView }>(`/assets/${id}/assign`, { method: 'POST', body: input });
}

export function returnAsset(
  id: string,
  input: { notes?: string | null } = {},
): Promise<{ asset: AssetView }> {
  return apiRequest<{ asset: AssetView }>(`/assets/${id}/return`, { method: 'POST', body: input });
}

export function retireAsset(id: string, reason?: string): Promise<{ asset: AssetView }> {
  return apiRequest<{ asset: AssetView }>(`/assets/${id}/retire`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

export function disposeAsset(id: string, reason?: string): Promise<{ asset: AssetView }> {
  return apiRequest<{ asset: AssetView }>(`/assets/${id}/dispose`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

export function listAssetAssignments(
  id: string,
  signal?: AbortSignal,
): Promise<{ items: AssetAssignmentView[] }> {
  return apiRequest<{ items: AssetAssignmentView[] }>(`/assets/${id}/assignments`, { signal });
}

export function listAssetTypes(signal?: AbortSignal): Promise<{ items: AssetTypeView[] }> {
  return apiRequest<{ items: AssetTypeView[] }>('/admin/asset-types', { signal });
}

export function createAssetType(input: {
  key: string;
  name: string;
  description?: string | null;
  attributeSchema?: { required?: string[] };
}): Promise<{ assetType: AssetTypeView }> {
  return apiRequest<{ assetType: AssetTypeView }>('/admin/asset-types', {
    method: 'POST',
    body: input,
  });
}
