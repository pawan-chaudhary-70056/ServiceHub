import type { DirectorySyncState, DirectoryUserMapping, Prisma } from '@prisma/client';
import { prisma, type DataClient } from './db';

/** Re-exported so services can name the row types without importing Prisma directly. */
export type { DirectorySyncState, DirectoryUserMapping };

/**
 * Roster sync persistence (`docs/32` §6).
 *
 * Two tables: the **per-tenant sync state** (last outcome, counts, resumable checkpoint) and
 * the **external-id → user mapping**. The mapping is the identity anchor: reconciliation never
 * keys on a mutable attribute like email, and the mapping survives deactivation so a returning
 * person is recognised rather than duplicated.
 *
 * Only `services/` may import this module (`docs/03` §4).
 */

export function getSyncState(
  organizationId: string,
  client: DataClient = prisma,
): Promise<DirectorySyncState | null> {
  return client.directorySyncState.findUnique({ where: { organizationId } });
}

export function saveSyncState(
  organizationId: string,
  data: Omit<Prisma.DirectorySyncStateUncheckedCreateInput, 'organizationId'>,
  client: DataClient = prisma,
): Promise<DirectorySyncState> {
  return client.directorySyncState.upsert({
    where: { organizationId },
    create: { organizationId, ...data },
    update: data,
  });
}

export function listMappings(
  organizationId: string,
  client: DataClient = prisma,
): Promise<DirectoryUserMapping[]> {
  return client.directoryUserMapping.findMany({ where: { organizationId } });
}

export function findMapping(
  organizationId: string,
  externalId: string,
  client: DataClient = prisma,
): Promise<DirectoryUserMapping | null> {
  return client.directoryUserMapping.findUnique({
    where: { organizationId_externalId: { organizationId, externalId } },
  });
}

export function countMappings(
  organizationId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.directoryUserMapping.count({ where: { organizationId } });
}

export function createMapping(
  input: { organizationId: string; externalId: string; userId: string },
  client: DataClient = prisma,
): Promise<DirectoryUserMapping> {
  return client.directoryUserMapping.create({ data: input });
}

/** The roster owns `displayName` and nothing else it does not own (`docs/32` §6). */
export function updateUserDisplayName(
  userId: string,
  displayName: string,
  client: DataClient = prisma,
): Promise<unknown> {
  return client.user.update({ where: { id: userId }, data: { displayName } });
}
