import {
  hasAnyPermission,
  hasPermission,
  INCIDENT_READ_PERMISSIONS,
  REQUEST_READ_PERMISSIONS,
  type Principal,
} from '../helpers/authorization';
import { ForbiddenError } from '../utils/errors';
import { decodeCursor, encodeCursor } from '../utils/pagination';
import {
  listTeamIdsForUser,
  searchRows,
  type SearchEntityType,
  type SearchRow,
  type SearchSources,
} from '../models';
import type { IncidentScope } from '../models/incident.model';
import type { RequestScope } from '../models/request.model';
import { resolveArticleScope } from './kb.service';
import { resolveAssetScope } from './asset.service';

/**
 * Unified search — docs/30 §2, F-13.
 *
 * Technology is PostgreSQL FTS (`§2.2`, `ADR-0009`); the data layer expresses the query.
 * This module decides **which sources the caller may search** and shapes the response. The
 * two rules of `§2.3` are the data layer's, and this module never re-ranks or re-filters:
 *
 *   - **S1** — visibility is a SQL predicate, applied before ranking and pagination.
 *   - **S2** — filter → rank → paginate, in one statement.
 *
 * A source the caller cannot read is not searched at all — a caller without `user:manage`
 * gets no user results, not empty ones, so their absence is not a signal.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface SearchInput {
  query: string;
  types?: SearchEntityType[];
  limit?: number;
  cursor?: string;
}

export interface SearchResultItem {
  entityType: SearchEntityType;
  id: string;
  reference: string | null;
  title: string;
  subtitle: string | null;
  status: string | null;
  href: string | null;
  /** A `ts_headline` excerpt, or null when there was no full-text match to highlight. */
  snippet: string | null;
}

export interface SearchResult {
  items: SearchResultItem[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Set when the query was too short for full-text and only exact matches were returned. */
  fallback: 'EXACT_ONLY' | null;
  /** The sources actually searched, so the UI can say what was covered. */
  searchedTypes: SearchEntityType[];
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can search.');
  }
  return actor.organizationId;
}

function resolveRequestScope(actor: Principal): RequestScope {
  if (hasPermission(actor, 'request:read.any')) return 'any';
  if (hasPermission(actor, 'request:read.team')) return 'team';
  return 'own';
}

function resolveIncidentScope(actor: Principal): IncidentScope {
  if (hasPermission(actor, 'incident:read.any')) return 'any';
  if (hasPermission(actor, 'incident:read.team')) return 'team';
  return 'own';
}

export function hrefFor(entityType: SearchEntityType, id: string): string | null {
  switch (entityType) {
    case 'REQUEST':
      return `/requests/${id}`;
    case 'INCIDENT':
      return `/incidents/${id}`;
    case 'CATALOG_ITEM':
      return '/catalog';
    case 'USER':
      return '/users';
    case 'ARTICLE':
      return `/kb/${id}`;
    case 'ASSET':
      return `/assets/${id}`;
    default:
      return null;
  }
}

/** The sources the caller may search, and the scope resolved for each. */
function resolveSources(
  actor: Principal,
  requested: SearchEntityType[],
): { sources: SearchSources; searchedTypes: SearchEntityType[] } {
  const wanted = new Set(requested);
  const searchedTypes: SearchEntityType[] = [];

  const request =
    wanted.has('REQUEST') && hasAnyPermission(actor, REQUEST_READ_PERMISSIONS)
      ? resolveRequestScope(actor)
      : null;
  if (request) searchedTypes.push('REQUEST');

  const incident =
    wanted.has('INCIDENT') && hasAnyPermission(actor, INCIDENT_READ_PERMISSIONS)
      ? resolveIncidentScope(actor)
      : null;
  if (incident) searchedTypes.push('INCIDENT');

  const catalog = wanted.has('CATALOG_ITEM') && hasPermission(actor, 'catalog:read');
  if (catalog) searchedTypes.push('CATALOG_ITEM');

  const users = wanted.has('USER') && hasPermission(actor, 'user:manage');
  if (users) searchedTypes.push('USER');

  // Knowledge articles are searchable by anyone entitled to read knowledge; the visibility
  // class narrows which articles that is, as a SQL pre-filter (`docs/27` §10, rule K3).
  const article =
    wanted.has('ARTICLE') && hasPermission(actor, 'kb:article:read')
      ? { scope: resolveArticleScope(actor), userId: actor.userId }
      : null;
  if (article) searchedTypes.push('ARTICLE');

  // The asset register is searchable by a caller entitled to read assets; the holder scope
  // narrows it in SQL, exactly as the register's own list does (`docs/28` §6, `docs/30` §2.3).
  const asset =
    wanted.has('ASSET') && hasAnyPermission(actor, ['asset:read.own', 'asset:read.any'])
      ? { scope: resolveAssetScope(actor), userId: actor.userId }
      : null;
  if (asset) searchedTypes.push('ASSET');

  return {
    sources: {
      request,
      incident,
      catalog,
      catalogIncludeUnavailable: hasPermission(actor, 'catalog:manage'),
      users,
      article,
      asset,
    },
    searchedTypes,
  };
}

function toResultItem(row: SearchRow): SearchResultItem {
  const entityType = row.entity_type as SearchEntityType;
  return {
    entityType,
    id: row.id,
    reference: row.reference,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    href: hrefFor(entityType, row.id),
    snippet: row.snippet,
  };
}

const ALL_TYPES: SearchEntityType[] = [
  'REQUEST',
  'INCIDENT',
  'CATALOG_ITEM',
  'USER',
  'ARTICLE',
  'ASSET',
];

/** Runs a unified, permission-scoped search (`docs/30` §2, §5). */
export async function search(actor: Principal, input: SearchInput): Promise<SearchResult> {
  const organizationId = requireTenant(actor);
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const requested = input.types && input.types.length > 0 ? input.types : ALL_TYPES;
  const offset = input.cursor ? Number(decodeCursor(input.cursor).sortValue) || 0 : 0;

  // A query shorter than two characters has no full-text terms (`docs/30` §2.4); only exact
  // identifier matches are attempted. An empty query is a recency browse.
  const exactOnly = query.length === 1;

  const { sources, searchedTypes } = resolveSources(actor, requested);
  // An exact lookup only searches identifier-bearing sources.
  const effectiveTypes = exactOnly
    ? searchedTypes.filter((type) => type === 'REQUEST' || type === 'INCIDENT')
    : searchedTypes;

  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  const rows = await searchRows({
    organizationId,
    userId: actor.userId,
    teamIds,
    query,
    sources,
    limit: limit + 1,
    offset,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map(toResultItem),
    nextCursor: hasMore ? encodeCursor(offset + page.length, 'search') : null,
    hasMore,
    fallback: exactOnly ? 'EXACT_ONLY' : null,
    searchedTypes: effectiveTypes,
  };
}
