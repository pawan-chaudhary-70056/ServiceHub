import { apiDownload, apiRequest, type DownloadedFile } from './client';

/**
 * Search and reporting API (docs/30 §5, docs/11 §9).
 *
 * The server scopes both to the caller: a result the caller cannot read is simply absent
 * (`docs/30` §2.3), and a report reflects only the caller's scope (`§3.2` R3). The client
 * adds no filtering of its own, so it can never appear to widen what the server allows.
 */

export type SearchEntityType =
  'REQUEST' | 'INCIDENT' | 'CATALOG_ITEM' | 'USER' | 'ARTICLE' | 'ASSET';

export interface SearchResultItem {
  entityType: SearchEntityType;
  id: string;
  reference: string | null;
  title: string;
  subtitle: string | null;
  status: string | null;
  href: string | null;
  snippet: string | null;
}

export interface SearchResult {
  items: SearchResultItem[];
  nextCursor: string | null;
  hasMore: boolean;
  fallback: 'EXACT_ONLY' | null;
  searchedTypes: SearchEntityType[];
}

export interface SearchParams {
  q: string;
  types?: SearchEntityType[];
  limit?: number;
  cursor?: string;
}

export function search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
  const query = new URLSearchParams();
  query.set('q', params.q);
  if (params.types && params.types.length > 0) query.set('types', params.types.join(','));
  if (params.limit) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  return apiRequest<SearchResult>(`/search?${query.toString()}`, { signal });
}

export interface ReportResult {
  metric: string;
  period: { from: string; to: string; timeZone: string };
  scope: 'own' | 'team' | 'any';
  generatedAt: string;
  figures: Record<string, unknown>;
}

export function runReport(
  metric: string,
  params: { from?: string; to?: string } = {},
  signal?: AbortSignal,
): Promise<{ report: ReportResult }> {
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<{ report: ReportResult }>(`/reports/${metric}${suffix}`, { signal });
}

/**
 * Async report exports (docs/30 §3.4/§5). An export is an async job the server scopes to
 * its requester, so the client polls the job and offers the link the server returns — it
 * never constructs a download URL the caller might not be entitled to.
 */

export type ReportExportStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface ReportExport {
  id: string;
  metric: string;
  format: string;
  status: ReportExportStatus;
  rowCount: number;
  params: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  downloadUrl: string | null;
}

/** Queues an export and returns the job (`docs/30` §5, R4 — never inline). */
export function requestReportExport(
  metric: string,
  params: { from?: string; to?: string } = {},
): Promise<{ export: ReportExport }> {
  return apiRequest<{ export: ReportExport }>(`/reports/${metric}/export`, {
    method: 'POST',
    body: {
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {}),
    },
  });
}

/** The export's status and, once it has succeeded, its time-limited download link. */
export function getReportExport(
  id: string,
  signal?: AbortSignal,
): Promise<{ export: ReportExport }> {
  return apiRequest<{ export: ReportExport }>(`/reports/jobs/${id}`, { signal });
}

/** Fetches the export CSV, subject to the server's ownership and expiry rules. */
export function fetchReportExportFile(id: string, signal?: AbortSignal): Promise<DownloadedFile> {
  return apiDownload(`/reports/jobs/${id}/download`, signal);
}
