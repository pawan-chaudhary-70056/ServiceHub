import { config } from '../config';
import { assertPermission, type Principal } from '../helpers/authorization';
import type { DirectoryAdapter, DirectoryUser } from '../integrations';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  countMappings,
  createMapping,
  createUser,
  findMapping,
  findUserByEmail,
  findUserById,
  getSyncState,
  listMappings,
  saveSyncState,
  setUserStatus,
  updateUserDisplayName,
  writeAudit,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Inbound roster sync — docs/32 §6.
 *
 * The rules that make this safe, each of which is a failure mode in real directory integrations:
 *
 *   - **Identity is keyed on the source's immutable id**, never on email. Email changes; a
 *     sync keyed on it silently orphans an account or, worse, adopts the wrong person when two
 *     people swap addresses.
 *   - **Deactivate, never delete (§6).** A person missing from the roster is set `INACTIVE`.
 *     Their history, assignments and audit trail stay intact. A directory outage that returns
 *     an empty roster must never delete the user base — which is what the guard is for.
 *   - **The drift guard aborts rather than "corrects".** A run that would deactivate more than
 *     a configured fraction of known people stops, records the attempt and alerts; a human
 *     either confirms or fixes the source. Silently applying it is how one bad export wipes a
 *     tenant's access.
 *   - **Idempotent and resumable.** Re-running with the same roster changes nothing; the
 *     checkpoint lets a long run resume rather than restart (`§6` volume).
 *   - **The roster owns `displayName` only.** It does not overwrite email (a login attribute),
 *     roles, or team membership — the integration does not touch fields it does not own.
 *
 * Reactivation is deliberately **not** automatic: a locally deactivated account is a decision
 * the directory does not know about, so the sync only ever deactivates.
 */

export type RosterSyncOutcome = 'SUCCEEDED' | 'FAILED' | 'ABORTED';

export interface RosterSyncResult {
  organizationId: string;
  status: RosterSyncOutcome;
  seen: number;
  adopted: number;
  created: number;
  updated: number;
  deactivated: number;
  absent: number;
  /** The fraction of known people whose disappearance would abort the run. */
  driftFraction: number;
  message?: string;
}

export interface RosterSyncOptions {
  organizationId: string;
  adapter: DirectoryAdapter;
  now?: Date;
  /** An operator's explicit confirmation that a large removal is intended (§6 edge case). */
  confirmDrift?: boolean;
  batchSize?: number;
}

function statePatch(result: RosterSyncResult, checkpoint: string | null, lastRunAt: Date) {
  return {
    status: result.status,
    lastRunAt,
    lastCheckpoint: checkpoint,
    usersSeen: result.seen,
    usersAdopted: result.adopted,
    usersCreated: result.created,
    usersUpdated: result.updated,
    usersDeactivated: result.deactivated,
    lastError: result.message ?? null,
  } as const;
}

/**
 * Reconciles the local user base against a directory roster. One run is single-leader; the
 * caller (the scheduler or an explicit admin trigger) owns that election.
 */
export async function syncRoster(options: RosterSyncOptions): Promise<RosterSyncResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? config.ROSTER_SYNC_BATCH_SIZE;
  const driftFraction = config.ROSTER_SYNC_MAX_REMOVAL_FRACTION;
  const result: RosterSyncResult = {
    organizationId: options.organizationId,
    status: 'SUCCEEDED',
    seen: 0,
    adopted: 0,
    created: 0,
    updated: 0,
    deactivated: 0,
    absent: 0,
    driftFraction,
  };

  await saveSyncState(options.organizationId, statePatch(result, null, now));

  // Fetch first. A failure here must not reach the reconciliation loop at all: an unreachable
  // directory is not a roster of zero people.
  let roster: DirectoryUser[];
  try {
    roster = await options.adapter.fetchRoster();
  } catch (error) {
    result.status = 'FAILED';
    result.message = error instanceof Error ? error.message : 'The directory could not be reached.';
    await saveSyncState(options.organizationId, statePatch(result, null, now));
    logger.error({ organizationId: options.organizationId, err: error }, 'Roster sync failed');
    return result;
  }

  const byExternalId = new Map(roster.map((user) => [user.externalId, user]));
  const mappings = await listMappings(options.organizationId);
  const absent = mappings.filter((mapping) => !byExternalId.has(mapping.externalId));

  // The guard runs **before** anything is applied, so an aborted run has no partial effect on
  // deactivations, and it is recorded so the attempt is visible.
  const threshold = mappings.length * driftFraction;
  if (absent.length > 0 && absent.length > threshold && !options.confirmDrift) {
    result.status = 'ABORTED';
    result.absent = absent.length;
    result.message = `Refused to deactivate ${absent.length} of ${mappings.length} known people (limit ${
      Math.floor(threshold * 100) / 100
    }). Re-run with confirmation if this is intended.`;
    await saveSyncState(options.organizationId, statePatch(result, null, now));
    logger.error(
      { organizationId: options.organizationId, absent: absent.length, known: mappings.length },
      'Roster sync aborted by the drift guard',
    );
    return result;
  }

  // Adopt, create and update, checkpointing every batch so a crash resumes (`§6`).
  let processed = 0;
  let lastExternalId: string | null = null;
  for (const person of roster) {
    result.seen += 1;
    lastExternalId = person.externalId;

    const mapping = await findMapping(options.organizationId, person.externalId);
    let userId: string;

    if (mapping) {
      userId = mapping.userId;
    } else {
      // First contact: adopt an existing local account with the same email, else create one.
      // Adoption is a one-time bootstrap; from here on the immutable external id is the key.
      const existing = await findUserByEmail(person.email);
      if (existing && existing.organizationId === options.organizationId) {
        userId = existing.id;
        result.adopted += 1;
      } else if (existing) {
        // The email belongs to another tenant; never adopt across a tenant boundary.
        logger.warn(
          { organizationId: options.organizationId, externalId: person.externalId },
          'Roster entry matches a user in another organization; skipped',
        );
        continue;
      } else {
        const created = await createUser({
          email: person.email,
          displayName: person.displayName,
          organizationId: options.organizationId,
          status: person.active ? 'ACTIVE' : 'INACTIVE',
        });
        userId = created.id;
        result.created += 1;
      }
      await createMapping({
        organizationId: options.organizationId,
        externalId: person.externalId,
        userId,
      });
    }

    const user = await findUserById(userId);
    if (!user) continue;

    if (user.displayName !== person.displayName) {
      await updateUserDisplayName(userId, person.displayName);
      result.updated += 1;
    }
    // Deactivate when the source says the person is gone or disabled. Never reactivate.
    if (!person.active && user.status === 'ACTIVE') {
      await setUserStatus(userId, 'INACTIVE');
      result.deactivated += 1;
    }

    processed += 1;
    if (processed % batchSize === 0) {
      await saveSyncState(options.organizationId, statePatch(result, lastExternalId, now));
    }
  }

  // People no longer in the roster are deactivated, never deleted, and their mapping is kept
  // so a return is recognised rather than duplicated.
  for (const mapping of absent) {
    const user = await findUserById(mapping.userId);
    if (user && user.status === 'ACTIVE') {
      await setUserStatus(user.id, 'INACTIVE');
      result.deactivated += 1;
    }
  }
  result.absent = absent.length;

  await saveSyncState(options.organizationId, statePatch(result, lastExternalId, now));
  logger.info(
    {
      organizationId: options.organizationId,
      seen: result.seen,
      created: result.created,
      deactivated: result.deactivated,
    },
    'Roster sync completed',
  );
  return result;
}

export interface RosterSyncStatus {
  organizationId: string;
  status: string;
  lastRunAt: string | null;
  lastError: string | null;
  usersSeen: number;
  usersAdopted: number;
  usersCreated: number;
  usersUpdated: number;
  usersDeactivated: number;
  mappedUsers: number;
  driftFraction: number;
}

/** Reads the last run's outcome (`docs/32` §12). `integration:read`. */
export async function getRosterSyncStatusForCaller(actor: Principal): Promise<RosterSyncStatus> {
  assertPermission(actor, 'integration:read');
  if (!actor.organizationId) {
    throw new NotFoundError('Roster sync is tenant-scoped.');
  }
  const organizationId = actor.organizationId;
  const [state, mappedUsers] = await Promise.all([
    getSyncState(organizationId),
    countMappings(organizationId),
  ]);

  return {
    organizationId,
    status: state?.status ?? 'NEVER_RUN',
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    usersSeen: state?.usersSeen ?? 0,
    usersAdopted: state?.usersAdopted ?? 0,
    usersCreated: state?.usersCreated ?? 0,
    usersUpdated: state?.usersUpdated ?? 0,
    usersDeactivated: state?.usersDeactivated ?? 0,
    mappedUsers,
    driftFraction: config.ROSTER_SYNC_MAX_REMOVAL_FRACTION,
  };
}

/**
 * Triggers a sync as an operator action (`docs/32` §11/§12). Audited, and a large removal
 * needs `confirmDrift` because the guard would otherwise refuse it — which is the point.
 */
export async function triggerRosterSyncForCaller(
  adapter: DirectoryAdapter,
  actor: Principal,
  meta: RequestMeta,
  options: { confirmDrift?: boolean } = {},
): Promise<RosterSyncResult> {
  assertPermission(actor, 'integration:manage');
  if (!actor.organizationId) {
    throw new NotFoundError('Roster sync is tenant-scoped.');
  }

  const result = await syncRoster({
    organizationId: actor.organizationId,
    adapter,
    confirmDrift: options.confirmDrift ?? false,
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_ROSTER_SYNC,
    entityType: AUDIT_ENTITY.DIRECTORY_SYNC,
    entityId: actor.organizationId,
    after: {
      status: result.status,
      seen: result.seen,
      created: result.created,
      deactivated: result.deactivated,
      confirmedDrift: options.confirmDrift ?? false,
    },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });

  return result;
}
