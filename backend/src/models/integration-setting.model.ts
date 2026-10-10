import { Prisma, type IntegrationSetting } from '@prisma/client';
import { prisma, type DataClient } from './db';

/** Re-exported so services can name the row type without importing Prisma directly. */
export type { IntegrationSetting };

/**
 * Integration configuration persistence (`docs/32` §7/§11/§12).
 *
 * The row holds **non-secret** configuration only: an enabled flag, reliability tuning and a
 * credential *reference*. The credential value itself is never stored here — it is injected
 * at runtime (`17` §3, `35`), so a database dump cannot become a credential dump.
 *
 * Only `services/` may import this module (`docs/03` §4).
 */

export function listIntegrationSettings(
  organizationId: string,
  client: DataClient = prisma,
): Promise<IntegrationSetting[]> {
  return client.integrationSetting.findMany({
    where: { organizationId },
    orderBy: [{ key: 'asc' }],
  });
}

export function findIntegrationSetting(
  organizationId: string,
  key: string,
  client: DataClient = prisma,
): Promise<IntegrationSetting | null> {
  return client.integrationSetting.findUnique({
    where: { organizationId_key: { organizationId, key } },
  });
}

export interface UpsertIntegrationSettingInput {
  enabled: boolean;
  config: Prisma.InputJsonValue;
  credentialRef: string | null;
  actorId: string | null;
}

/**
 * Creates or replaces the configuration for one integration key.
 *
 * Upsert rather than create-then-update because the natural key is `(organizationId, key)`:
 * a caller configuring an integration it has never configured before should not have to know
 * whether the row already exists.
 */
export function upsertIntegrationSetting(
  organizationId: string,
  key: string,
  input: UpsertIntegrationSettingInput,
  client: DataClient = prisma,
): Promise<IntegrationSetting> {
  return client.integrationSetting.upsert({
    where: { organizationId_key: { organizationId, key } },
    create: {
      organizationId,
      key,
      enabled: input.enabled,
      config: input.config,
      credentialRef: input.credentialRef,
      createdById: input.actorId,
      updatedById: input.actorId,
    },
    update: {
      enabled: input.enabled,
      config: input.config,
      credentialRef: input.credentialRef,
      updatedById: input.actorId,
    },
  });
}

/** Records the outcome of a bounded connection test (`docs/32` §13 "test connection"). */
export function recordIntegrationTest(
  id: string,
  result: { status: 'OK' | 'FAILED'; error: string | null; at: Date },
  client: DataClient = prisma,
): Promise<IntegrationSetting> {
  return client.integrationSetting.update({
    where: { id },
    data: { lastTestedAt: result.at, lastTestStatus: result.status, lastTestError: result.error },
  });
}
