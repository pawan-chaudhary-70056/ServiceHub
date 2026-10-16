import type {
  BusinessCalendar,
  SlaCalendarModel,
  SlaClock,
  SlaClockState,
  SlaPolicy,
  SlaTarget,
  Priority,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * SLA policy, calendar and clock data access — docs/25, F-08, ADR-0008.
 *
 * The correctness rules that live here are the ones the database must guarantee:
 *
 *   - **Target instants are stored, never recomputed** (docs/25 §4 example 5). The
 *     clock columns `targetAt`/`warnAt` are the frozen result of calendar arithmetic at
 *     start; reading a clock never re-derives them from current policy data.
 *   - **`breachedAt` is recorded at detection** (docs/25 §6), so the API writing it is
 *     the sweep, not a read path.
 *   - **Editing a calendar is a new version** (docs/25 §4 rule 6): in-flight records keep
 *     the version they started under. The calendar row is immutable once referenced; a
 *     change creates a new row rather than mutating history.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export interface SlaTargetInput {
  priority: Priority;
  responseMinutes: number;
  resolveMinutes: number;
  warnPercent: number;
}

export interface SlaPolicyWithTargets extends SlaPolicy {
  targets: SlaTarget[];
  calendar: BusinessCalendar;
}

export interface CreateSlaClockData {
  organizationId: string;
  entityType: string;
  entityId: string;
  slaPolicyId: string;
  priority: Priority;
  cycle: number;
  startedAt: Date;
  targetAt: Date;
  warnAt: Date;
  state: SlaClockState;
}

// ---------------------------------------------------------------------------
// Business calendars
// ---------------------------------------------------------------------------

export function listBusinessCalendars(
  organizationId: string,
  client: DataClient = prisma,
): Promise<BusinessCalendar[]> {
  return client.businessCalendar.findMany({
    where: { organizationId },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { version: 'desc' }],
  });
}

export function findBusinessCalendarById(
  id: string,
  client: DataClient = prisma,
): Promise<BusinessCalendar | null> {
  return client.businessCalendar.findUnique({ where: { id } });
}

export function findBusinessCalendarByName(
  organizationId: string,
  name: string,
  client: DataClient = prisma,
): Promise<BusinessCalendar | null> {
  return client.businessCalendar.findFirst({
    where: { organizationId, name },
    orderBy: { version: 'desc' },
  });
}

export function createBusinessCalendar(
  data: {
    organizationId: string;
    name: string;
    timeZone: string;
    model: SlaCalendarModel;
    workingHours: Prisma.InputJsonValue;
    holidays: Prisma.InputJsonValue;
    version: number;
  },
  client: DataClient = prisma,
): Promise<BusinessCalendar> {
  return client.businessCalendar.create({ data });
}

/** A calendar referenced by a policy cannot be edited in place; see the module note. */
export function countPoliciesUsingCalendar(
  calendarId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.slaPolicy.count({ where: { calendarId } });
}

/**
 * Marks a version superseded: the row stays (history resolves against it) but stops
 * being the current one. Never a delete — policies and historical references keep it
 * alive, and rule 6 is about *versions*, not rows that vanish.
 */
export function supersedeBusinessCalendar(
  id: string,
  client: DataClient = prisma,
): Promise<BusinessCalendar> {
  return client.businessCalendar.update({ where: { id }, data: { isActive: false } });
}

/**
 * Moves every policy from one calendar version to its successor (docs/25 §13: "calendar
 * edited mid-cycle — in-flight records keep `targetAt`; **new records use the new
 * version**").
 *
 * The policy is the only path from a new record to a calendar, so the move is what makes
 * the new version actually take effect. It cannot move a deadline: a clock stores its
 * target instants at start and never re-derives them (`docs/25` §4 example 5), and a
 * policy's calendar being swapped underneath an in-flight clock is already the documented
 * behaviour of a policy edit.
 */
export function movePoliciesToCalendar(
  fromCalendarId: string,
  toCalendarId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.slaPolicy
    .updateMany({ where: { calendarId: fromCalendarId }, data: { calendarId: toCalendarId } })
    .then((result) => result.count);
}

// ---------------------------------------------------------------------------
// SLA policies and targets
// ---------------------------------------------------------------------------

export function listSlaPolicies(
  organizationId: string,
  client: DataClient = prisma,
): Promise<SlaPolicyWithTargets[]> {
  return client.slaPolicy.findMany({
    where: { organizationId },
    include: {
      targets: { orderBy: { priority: 'asc' } },
      calendar: true,
    },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
}

export function findSlaPolicyById(
  id: string,
  client: DataClient = prisma,
): Promise<SlaPolicyWithTargets | null> {
  return client.slaPolicy.findUnique({
    where: { id },
    include: { targets: { orderBy: { priority: 'asc' } }, calendar: true },
  });
}

export function findSlaPolicyByName(
  organizationId: string,
  name: string,
  client: DataClient = prisma,
): Promise<SlaPolicy | null> {
  return client.slaPolicy.findFirst({ where: { organizationId, name } });
}

export function findDefaultSlaPolicy(
  organizationId: string,
  client: DataClient = prisma,
): Promise<SlaPolicyWithTargets | null> {
  return client.slaPolicy.findFirst({
    where: { organizationId, isActive: true, isDefault: true },
    include: { targets: { orderBy: { priority: 'asc' } }, calendar: true },
  });
}

export function createSlaPolicy(
  data: {
    organizationId: string;
    name: string;
    calendarId: string;
    pauseStates: Prisma.InputJsonValue;
    isActive: boolean;
    isDefault: boolean;
    targets: SlaTargetInput[];
  },
  client: DataClient = prisma,
): Promise<SlaPolicyWithTargets> {
  const { targets, ...policy } = data;
  return client.slaPolicy.create({
    data: {
      ...policy,
      targets: { create: targets },
    },
    include: { targets: { orderBy: { priority: 'asc' } }, calendar: true },
  });
}

/**
 * Replaces a policy's targets wholesale.
 *
 * A target set is a matrix keyed by priority; applying a partial edit would leave a
 * policy with a differing shape per priority for no reason. Deleting and recreating the
 * rows also means a removed priority genuinely disappears rather than lingering.
 */
export function updateSlaPolicy(
  id: string,
  data: {
    name?: string;
    calendarId?: string;
    pauseStates?: Prisma.InputJsonValue;
    isActive?: boolean;
    isDefault?: boolean;
    targets?: SlaTargetInput[];
  },
  client: DataClient = prisma,
): Promise<SlaPolicyWithTargets> {
  const { targets, ...policy } = data;
  return client.slaPolicy.update({
    where: { id },
    data: {
      ...policy,
      ...(targets ? { targets: { deleteMany: {}, create: targets } } : {}),
    },
    include: { targets: { orderBy: { priority: 'asc' } }, calendar: true },
  });
}

export function clearDefaultSlaPolicies(
  organizationId: string,
  exceptId: string | null,
  client: DataClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.slaPolicy.updateMany({
    where: {
      organizationId,
      isDefault: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isDefault: false },
  });
}

export function findSlaTarget(
  slaPolicyId: string,
  priority: Priority,
  client: DataClient = prisma,
): Promise<SlaTarget | null> {
  return client.slaTarget.findUnique({
    where: { slaPolicyId_priority: { slaPolicyId, priority } },
  });
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

export function createSlaClock(
  data: CreateSlaClockData,
  client: DataClient = prisma,
): Promise<SlaClock> {
  return client.slaClock.create({ data });
}

/** The live clock for a record's current cycle (docs/25 §3). */
export function findOpenSlaClock(
  entityType: string,
  entityId: string,
  client: DataClient = prisma,
): Promise<SlaClock | null> {
  return client.slaClock.findFirst({
    where: { entityType, entityId, stoppedAt: null },
    orderBy: { cycle: 'desc' },
  });
}

export function stopSlaClock(
  id: string,
  stoppedAt: Date,
  client: DataClient = prisma,
): Promise<SlaClock> {
  return client.slaClock.update({
    where: { id },
    data: { stoppedAt, state: 'STOPPED' },
  });
}

// ---------------------------------------------------------------------------
// Pause / resume (docs/25 §3)
// ---------------------------------------------------------------------------

/**
 * Records a pause. Idempotent by construction: the caller only pauses a clock that is
 * not already paused, and the sweep ignores paused clocks.
 */
export function pauseSlaClock(
  id: string,
  pausedAt: Date,
  client: DataClient = prisma,
): Promise<SlaClock> {
  return client.slaClock.update({
    where: { id },
    data: { pausedAt, state: 'PAUSED' },
  });
}

/**
 * Resumes a paused clock, pushing the target instants out by the paused duration and
 * accumulating the paused time (docs/25 §3). The target is *shifted*, never recomputed
 * from policy, so the frozen-target rule (§4 example 5) still holds.
 */
export function resumeSlaClock(
  id: string,
  data: { totalPausedSeconds: number; targetAt: Date; warnAt: Date; state: SlaClockState },
  client: DataClient = prisma,
): Promise<SlaClock> {
  return client.slaClock.update({
    where: { id },
    data: { ...data, pausedAt: null },
  });
}

// ---------------------------------------------------------------------------
// Sweep (docs/25 §6)
// ---------------------------------------------------------------------------

/**
 * Clocks whose target instant has passed while still running — the ones due to breach.
 * Restricted to `ON_TRACK`/`AT_RISK` so a clock can breach at most once per cycle, which
 * is what makes the sweep idempotent (docs/25 §6).
 */
export function listClocksDueForBreach(
  now: Date,
  limit: number,
  client: DataClient = prisma,
): Promise<SlaClock[]> {
  return client.slaClock.findMany({
    where: { stoppedAt: null, state: { in: ['ON_TRACK', 'AT_RISK'] }, targetAt: { lte: now } },
    orderBy: { targetAt: 'asc' },
    take: limit,
  });
}

/** Running clocks that have crossed their warn threshold but not yet their target. */
export function listClocksDueForWarn(
  now: Date,
  limit: number,
  client: DataClient = prisma,
): Promise<SlaClock[]> {
  return client.slaClock.findMany({
    where: { stoppedAt: null, state: 'ON_TRACK', warnAt: { lte: now }, targetAt: { gt: now } },
    orderBy: { warnAt: 'asc' },
    take: limit,
  });
}

/** Records a breach at detection time; `breachedAt` is never inferred (docs/25 §6). */
export function markClockBreached(
  id: string,
  breachedAt: Date,
  client: DataClient = prisma,
): Promise<SlaClock> {
  return client.slaClock.update({
    where: { id },
    data: { breachedAt, state: 'BREACHED' },
  });
}

export function markClockAtRisk(id: string, client: DataClient = prisma): Promise<SlaClock> {
  return client.slaClock.update({ where: { id }, data: { state: 'AT_RISK' } });
}

export function findSlaClockById(
  id: string,
  client: DataClient = prisma,
): Promise<SlaClock | null> {
  return client.slaClock.findUnique({ where: { id } });
}

/**
 * The live clocks for a set of records, in one query.
 *
 * A page of records renders an SLA indicator per row (`docs/25` §12), and a per-row
 * query would turn one page into N+1 — the cost `docs/33` §7 forbids. Stopped clocks are
 * excluded because a stopped clock is history, not the record's current SLA.
 */
export function listOpenSlaClocksForEntities(
  organizationId: string,
  entityType: string,
  entityIds: string[],
  client: DataClient = prisma,
): Promise<SlaClock[]> {
  if (entityIds.length === 0) {
    return Promise.resolve([]);
  }
  return client.slaClock.findMany({
    // The tenant predicate is required, not optional (`ADR-0002`) — and it is also the
    // leading column of `@@index([organizationId, entityType, entityId])`, so the page
    // read is an index lookup rather than a scan.
    where: { organizationId, entityType, entityId: { in: entityIds }, stoppedAt: null },
    orderBy: { cycle: 'desc' },
  });
}

/**
 * Applies an explicit, audited override to a clock (`docs/25` §11).
 *
 * The frozen-target rule protects a clock from *policy* edits (§4 example 5), not from a
 * deliberate human decision with a recorded reason — which is what this writes. Nothing
 * here recomputes a target from policy data, so the rule still holds.
 */
export function updateSlaClockOverride(
  id: string,
  data: {
    targetAt?: Date;
    warnAt?: Date;
    breachedAt?: Date | null;
    state: SlaClockState;
  },
  client: DataClient = prisma,
): Promise<SlaClock> {
  return client.slaClock.update({ where: { id }, data });
}
