import { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { RequestScope } from './request.model';
import type { IncidentScope } from './incident.model';
import type { ArticleVisibilityScope } from './kb.model';
import type { AssetScope } from './asset.model';

/**
 * Search data access — docs/30 §2, F-13.
 *
 * Technology is PostgreSQL full-text search (`docs/30` §2.2, `ADR-0009`): GIN expression
 * indexes over `to_tsvector('english', …)` (migration `20261006082530_search_fts`), queried
 * with `websearch_to_tsquery` and ranked by `ts_rank`.
 *
 * The security core (`docs/30` §2.3) is a property of this query, not of a caller:
 *
 *   - **S1** — visibility is a SQL predicate, applied **before** ranking and pagination.
 *     Each source branch carries the caller's scope in its `WHERE`.
 *   - **S2** — the order is filter → rank → paginate, in **one** statement: a `UNION ALL`
 *     of the permitted source branches is ranked and limited together.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export type SearchEntityType =
  'REQUEST' | 'INCIDENT' | 'CATALOG_ITEM' | 'USER' | 'ARTICLE' | 'ASSET';

export interface SearchRow {
  entity_type: string;
  id: string;
  reference: string | null;
  title: string;
  subtitle: string | null;
  status: string | null;
  rank: number;
  snippet: string | null;
}

/** Which sources the caller may search, and the resolved scope for each scoped one. */
export interface SearchSources {
  request: RequestScope | null;
  incident: IncidentScope | null;
  catalog: boolean;
  /** Whether an unmanaged caller is restricted to ACTIVE catalog items (`docs/21` §4). */
  catalogIncludeUnavailable: boolean;
  users: boolean;
  /**
   * Knowledge articles, with the caller's widest visibility class (`docs/27` §10).
   * `PUBLISHED` only, and visibility is a pre-filter — never rank, then hide.
   */
  article: { scope: ArticleVisibilityScope; userId: string } | null;
  /**
   * The asset register (`docs/30` §2.1), scoped to the holder unless the caller holds
   * `asset:read.any` (`docs/28` §6).
   */
  asset: { scope: AssetScope; userId: string } | null;
}

export interface SearchQueryParams {
  organizationId: string;
  userId: string;
  teamIds: string[];
  query: string;
  sources: SearchSources;
  /** Row count to fetch (limit + 1, so `hasMore` needs no second query). */
  limit: number;
  offset: number;
}

// The concatenation order MUST match the GIN index expressions exactly (docs/09 §4).
const REQUEST_VECTOR = Prisma.sql`to_tsvector('english', coalesce(r."reference", '') || ' ' || coalesce(r."title", '') || ' ' || coalesce(r."description", ''))`;
const INCIDENT_VECTOR = Prisma.sql`to_tsvector('english', coalesce(i."reference", '') || ' ' || coalesce(i."title", '') || ' ' || coalesce(i."description", '') || ' ' || coalesce(i."resolution_summary", ''))`;
const CATALOG_VECTOR = Prisma.sql`to_tsvector('english', coalesce(c."name", '') || ' ' || coalesce(c."description", ''))`;
const USER_VECTOR = Prisma.sql`to_tsvector('english', coalesce(u."display_name", '') || ' ' || coalesce(u."email", ''))`;
// Must match `articles_search_idx` exactly, including the `setweight` classes (docs/09 §4).
const ARTICLE_VECTOR = Prisma.sql`(setweight(to_tsvector('english', coalesce(a."title", '') || ' ' || coalesce(a."summary", '')), 'A') || setweight(to_tsvector('english', coalesce(a."body", '')), 'B'))`;
// Must match `assets_search_idx` exactly (docs/09 §4).
const ASSET_VECTOR = Prisma.sql`to_tsvector('english', coalesce(s."tag", '') || ' ' || coalesce(s."serial_number", '') || ' ' || coalesce(s."name", ''))`;

/** `IN` list for team ids, or an always-false clause when the caller has no teams. */
function teamIn(column: Prisma.Sql, teamIds: string[]): Prisma.Sql {
  if (teamIds.length === 0) return Prisma.sql`false`;
  return Prisma.sql`${column} IN (${Prisma.join(teamIds)})`;
}

/** Text predicate: FTS when the query is long enough, exact reference otherwise. */
function textPredicate(
  mode: 'fts' | 'exact' | 'browse',
  vector: Prisma.Sql,
  referenceColumn: Prisma.Sql | null,
  query: string,
): Prisma.Sql {
  if (mode === 'fts') return Prisma.sql`AND ${vector} @@ q.query`;
  if (mode === 'exact' && referenceColumn) return Prisma.sql`AND ${referenceColumn} ILIKE ${query}`;
  return Prisma.empty;
}

/** Rank: `ts_rank` with an exact-reference boost (`docs/30` §2.1), else 0 for a browse. */
function rankExpr(
  mode: 'fts' | 'exact' | 'browse',
  vector: Prisma.Sql,
  referenceColumn: Prisma.Sql | null,
  query: string,
): Prisma.Sql {
  if (mode !== 'fts') return Prisma.sql`0::float8`;
  const boost = referenceColumn
    ? Prisma.sql` + CASE WHEN ${referenceColumn} ILIKE ${`${query}%`} THEN 2.0 ELSE 0.0 END`
    : Prisma.empty;
  return Prisma.sql`(ts_rank(${vector}, q.query)::float8${boost})`;
}

function requestBranch(p: SearchQueryParams, mode: 'fts' | 'exact' | 'browse'): Prisma.Sql {
  const body = Prisma.sql`coalesce(r."reference", '') || ' ' || coalesce(r."title", '') || ' ' || coalesce(r."description", '')`;
  const scope = p.sources.request ?? 'own';
  const scopeSql =
    scope === 'any'
      ? Prisma.empty
      : scope === 'team'
        ? Prisma.sql`AND (r."requester_id" = ${p.userId} OR r."assignee_id" = ${p.userId} OR ${teamIn(Prisma.sql`r."team_id"`, p.teamIds)})`
        : Prisma.sql`AND r."requester_id" = ${p.userId}`;
  return Prisma.sql`
    SELECT 'REQUEST' AS entity_type, r."id" AS id, r."reference" AS reference,
           r."title" AS title, r."description" AS subtitle, r."status"::text AS status,
           r."updated_at" AS updated_at, ${body} AS body_text,
           ${rankExpr(mode, REQUEST_VECTOR, Prisma.sql`r."reference"`, p.query)} AS rank
    FROM service_requests r, q
    WHERE r."organization_id" = ${p.organizationId}
      ${textPredicate(mode, REQUEST_VECTOR, Prisma.sql`r."reference"`, p.query)}
      ${scopeSql}
  `;
}

function incidentBranch(p: SearchQueryParams, mode: 'fts' | 'exact' | 'browse'): Prisma.Sql {
  const body = Prisma.sql`coalesce(i."reference", '') || ' ' || coalesce(i."title", '') || ' ' || coalesce(i."description", '') || ' ' || coalesce(i."resolution_summary", '')`;
  const scope = p.sources.incident ?? 'own';
  const scopeSql =
    scope === 'any'
      ? Prisma.empty
      : scope === 'team'
        ? Prisma.sql`AND (i."reporter_id" = ${p.userId} OR i."assignee_id" = ${p.userId} OR ${teamIn(Prisma.sql`i."team_id"`, p.teamIds)})`
        : Prisma.sql`AND i."reporter_id" = ${p.userId}`;
  return Prisma.sql`
    SELECT 'INCIDENT' AS entity_type, i."id" AS id, i."reference" AS reference,
           i."title" AS title, i."description" AS subtitle, i."status"::text AS status,
           i."updated_at" AS updated_at, ${body} AS body_text,
           ${rankExpr(mode, INCIDENT_VECTOR, Prisma.sql`i."reference"`, p.query)} AS rank
    FROM incidents i, q
    WHERE i."organization_id" = ${p.organizationId}
      ${textPredicate(mode, INCIDENT_VECTOR, Prisma.sql`i."reference"`, p.query)}
      ${scopeSql}
  `;
}

function catalogBranch(p: SearchQueryParams, mode: 'fts' | 'browse'): Prisma.Sql {
  const body = Prisma.sql`coalesce(c."name", '') || ' ' || coalesce(c."description", '')`;
  const statusSql = p.sources.catalogIncludeUnavailable
    ? Prisma.empty
    : Prisma.sql`AND c."status"::text = 'ACTIVE'`;
  return Prisma.sql`
    SELECT 'CATALOG_ITEM' AS entity_type, c."id" AS id, NULL::text AS reference,
           c."name" AS title, c."description" AS subtitle, c."status"::text AS status,
           c."updated_at" AS updated_at, ${body} AS body_text,
           ${rankExpr(mode, CATALOG_VECTOR, null, p.query)} AS rank
    FROM catalog_items c, q
    WHERE c."organization_id" = ${p.organizationId}
      ${textPredicate(mode, CATALOG_VECTOR, null, p.query)}
      ${statusSql}
  `;
}

function userBranch(p: SearchQueryParams, mode: 'fts' | 'browse'): Prisma.Sql {
  const body = Prisma.sql`coalesce(u."display_name", '') || ' ' || coalesce(u."email", '')`;
  return Prisma.sql`
    SELECT 'USER' AS entity_type, u."id" AS id, NULL::text AS reference,
           u."display_name" AS title, u."email" AS subtitle, u."status"::text AS status,
           u."updated_at" AS updated_at, ${body} AS body_text,
           ${rankExpr(mode, USER_VECTOR, null, p.query)} AS rank
    FROM users u, q
    WHERE u."organization_id" = ${p.organizationId}
      ${textPredicate(mode, USER_VECTOR, null, p.query)}
  `;
}

/**
 * Knowledge articles (`docs/27` §10, `docs/30` §2.2).
 *
 * Two predicates are non-negotiable and both are SQL, applied before ranking (rule K3):
 *   - only `PUBLISHED` articles are searchable — a draft or an archived article is not
 *     merely hidden from the result list, it is not selected;
 *   - visibility is the caller's, using the **same** rule as the read path.
 */
function articleBranch(p: SearchQueryParams, mode: 'fts' | 'browse'): Prisma.Sql {
  const article = p.sources.article;
  if (!article) return Prisma.empty;

  const body = Prisma.sql`coalesce(a."title", '') || ' ' || coalesce(a."summary", '') || ' ' || coalesce(a."body", '')`;
  const scopeSql =
    article.scope === 'ALL'
      ? Prisma.empty
      : article.scope === 'INTERNAL'
        ? Prisma.sql`AND (a."visibility"::text IN ('PUBLIC', 'INTERNAL') OR (a."visibility"::text = 'RESTRICTED' AND (a."author_id" = ${article.userId} OR a."reviewer_id" = ${article.userId})))`
        : Prisma.sql`AND a."visibility"::text = 'PUBLIC'`;

  return Prisma.sql`
    SELECT 'ARTICLE' AS entity_type, a."id" AS id, NULL::text AS reference,
           a."title" AS title, a."summary" AS subtitle, a."status"::text AS status,
           a."updated_at" AS updated_at, ${body} AS body_text,
           ${rankExpr(mode, ARTICLE_VECTOR, null, p.query)} AS rank
    FROM articles a, q
    WHERE a."organization_id" = ${p.organizationId}
      AND a."status"::text = 'PUBLISHED'
      ${textPredicate(mode, ARTICLE_VECTOR, null, p.query)}
      ${scopeSql}
  `;
}

/**
 * The asset register (`docs/30` §2.1, `docs/28` §6).
 *
 * The holder scope is a SQL predicate, so a holder searching finds their own assets and
 * not the rest of the register — the same rule as the register's own list, expressed in
 * the same place as the ranking (S1).
 */
function assetBranch(p: SearchQueryParams, mode: 'fts' | 'browse'): Prisma.Sql {
  const asset = p.sources.asset;
  if (!asset) return Prisma.empty;

  const body = Prisma.sql`coalesce(s."tag", '') || ' ' || coalesce(s."serial_number", '') || ' ' || coalesce(s."name", '')`;
  const scopeSql =
    asset.scope === 'ANY'
      ? Prisma.empty
      : Prisma.sql`AND s."assigned_to_user_id" = ${asset.userId}`;

  return Prisma.sql`
    SELECT 'ASSET' AS entity_type, s."id" AS id, s."tag" AS reference,
           s."name" AS title, s."serial_number" AS subtitle, s."state"::text AS status,
           s."updated_at" AS updated_at, ${body} AS body_text,
           ${rankExpr(mode, ASSET_VECTOR, Prisma.sql`s."tag"`, p.query)} AS rank
    FROM assets s, q
    WHERE s."organization_id" = ${p.organizationId}
      ${textPredicate(mode, ASSET_VECTOR, Prisma.sql`s."tag"`, p.query)}
      ${scopeSql}
  `;
}

/**
 * Runs the unified, permission-scoped search as a single statement (`docs/30` §2.3 S2).
 *
 * A query shorter than two characters has no full-text terms (`§2.4`), so only an exact
 * reference match is attempted; an empty query is a recency browse.
 */
export async function searchRows(p: SearchQueryParams): Promise<SearchRow[]> {
  const trimmed = p.query.trim();
  const mode: 'fts' | 'exact' | 'browse' =
    trimmed.length === 0 ? 'browse' : trimmed.length < 2 ? 'exact' : 'fts';

  // An exact lookup searches identifiers only, so catalog/user branches carry no reference.
  const branches: Prisma.Sql[] = [];
  if (p.sources.request !== null) branches.push(requestBranch(p, mode));
  if (p.sources.incident !== null) branches.push(incidentBranch(p, mode));
  if (p.sources.catalog && mode !== 'exact') branches.push(catalogBranch(p, mode));
  if (p.sources.users && mode !== 'exact') branches.push(userBranch(p, mode));
  if (p.sources.article && mode !== 'exact') branches.push(articleBranch(p, mode));
  if (p.sources.asset && mode !== 'exact') branches.push(assetBranch(p, mode));

  if (branches.length === 0) return [];

  const snippet =
    mode === 'fts'
      ? Prisma.sql`ts_headline('english', body_text, (SELECT query FROM q))`
      : Prisma.sql`NULL::text`;

  const sql = Prisma.sql`
    WITH q AS (SELECT websearch_to_tsquery('english', ${trimmed}) AS query)
    SELECT entity_type, id, reference, title, subtitle, status, rank, ${snippet} AS snippet
    FROM ( ${Prisma.join(branches, ' UNION ALL ')} ) s
    ORDER BY rank DESC, updated_at DESC, id ASC
    LIMIT ${p.limit} OFFSET ${p.offset}
  `;

  return prisma.$queryRaw<SearchRow[]>(sql);
}
