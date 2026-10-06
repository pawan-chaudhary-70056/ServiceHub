import type { Organization, OrganizationStatus } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * Organization (tenant root) queries — docs/08 §4.8, `ADR-0012`.
 *
 * The organization is the tenancy boundary: every tenant-scoped row references it, and
 * `organizationId` is a mandatory filter in every tenant query (`ADR-0002`). This module
 * therefore owns the normalization that makes the tenant identity stable (`nameKey`,
 * `slug`) as well as the reads and writes of the root row itself.
 *
 * Only `services/` may import this module; controllers never reach it (docs/03 §4).
 */

/** Collapses internal whitespace and trims — the canonical display form (docs/12 §3). */
export function normalizeOrganizationName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * The uniqueness key for a name.
 *
 * A functional unique index (`lower(name)`) is not expressible in Prisma, so the
 * normalised key is stored and made unique instead (docs/08 §5). Two tenants named
 * "Acme" and "acme " are the same tenant attempt and must collide.
 */
export function organizationNameKey(name: string): string {
  return normalizeOrganizationName(name).toLowerCase();
}

/** A URL-safe slug derived from the name; collisions are resolved by the caller. */
export function organizationSlug(name: string): string {
  return normalizeOrganizationName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function findOrganizationById(
  id: string,
  client: DataClient = prisma,
): Promise<Organization | null> {
  return client.organization.findUnique({ where: { id } });
}

export function findOrganizationByNameKey(
  nameKey: string,
  client: DataClient = prisma,
): Promise<Organization | null> {
  return client.organization.findUnique({ where: { nameKey } });
}

export function findOrganizationBySlug(
  slug: string,
  client: DataClient = prisma,
): Promise<Organization | null> {
  return client.organization.findUnique({ where: { slug } });
}

export function createOrganization(
  data: { name: string; nameKey: string; slug: string; defaultTimeZone: string },
  client: DataClient = prisma,
): Promise<Organization> {
  return client.organization.create({ data });
}

export function setOrganizationStatus(
  id: string,
  status: OrganizationStatus,
  client: DataClient = prisma,
): Promise<Organization> {
  return client.organization.update({ where: { id }, data: { status } });
}

/**
 * Lists tenants newest-first, cursor-paginated (docs/11 §6).
 *
 * Fetches `limit + 1` rows so the caller can compute `hasMore` without a second count
 * query — an unbounded or double query is exactly what cursor pagination avoids. The
 * sort tuple is `(createdAt, id)`, with `id` the total-order tiebreaker.
 */
export function listOrganizations(
  params: { limit: number; cursor?: string },
  client: DataClient = prisma,
): Promise<Organization[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  return client.organization.findMany({
    ...(params.cursor
      ? {
          where: {
            OR: [
              { createdAt: { lt: new Date(sortValue) } },
              { createdAt: new Date(sortValue), id: { lt: id } },
            ],
          },
        }
      : {}),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });
}
