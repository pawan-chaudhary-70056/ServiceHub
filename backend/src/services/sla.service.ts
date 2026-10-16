import type { BusinessCalendar, Prisma, SlaCalendarModel, SlaClock } from '@prisma/client';
import { assertPermission, type Principal } from '../helpers/authorization';
import { ForbiddenError, NotFoundError, DuplicateError, ConflictError } from '../utils/errors';
import {
  clearDefaultSlaPolicies,
  createBusinessCalendar,
  createSlaPolicy,
  findBusinessCalendarById,
  findBusinessCalendarByName,
  findSlaClockById,
  findSlaPolicyById,
  findSlaPolicyByName,
  listBusinessCalendars,
  listSlaPolicies,
  movePoliciesToCalendar,
  runInTransaction,
  supersedeBusinessCalendar,
  updateSlaClockOverride,
  updateSlaPolicy,
  writeAudit,
  type SlaPolicyWithTargets,
  type SlaTargetInput,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';
import { assertIncidentVisible } from './incident.service';
import { invalidateReportCache } from './report-cache';
import { assertRequestVisible } from './request.service';
import { describeClock, deriveState, type SlaClockView } from './sla-clock.service';

/**
 * SLA policies, targets and calendars — docs/25, F-08, ADR-0008.
 *
 * This module owns **configuration** only. Clock mechanics (start/pause/resume/breach
 * detection) belong with the records that carry clocks — requests and incidents — and
 * are implemented alongside them (`docs/25` §3). What matters here is the rule that
 * makes reporting reproducible: a policy edit never rewrites an in-flight clock, because
 * the clock stores its target instants at start (docs/25 §4 example 5). That is why an
 * update is safe in place while a calendar change is a new version.
 */

const MANAGE_PERMISSION = 'sla:policy:manage';

export interface CreateCalendarInput {
  name: string;
  timeZone: string;
  model: SlaCalendarModel;
  workingHours: Record<string, Array<{ start: string; end: string }>>;
  holidays: string[];
}

export interface CreatePolicyInput {
  name: string;
  calendarId: string;
  pauseStates: string[];
  isActive: boolean;
  isDefault: boolean;
  targets: SlaTargetInput[];
}

export function listCalendars(actor: Principal): Promise<BusinessCalendar[]> {
  assertPermission(actor, MANAGE_PERMISSION);
  return listBusinessCalendars(requireTenant(actor));
}

export function listPolicies(actor: Principal): Promise<SlaPolicyWithTargets[]> {
  assertPermission(actor, MANAGE_PERMISSION);
  return listSlaPolicies(requireTenant(actor));
}

export function getPolicy(id: string, actor: Principal): Promise<SlaPolicyWithTargets> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  return findSlaPolicyById(id).then((policy) => {
    if (!policy || policy.organizationId !== organizationId) {
      throw new NotFoundError('SLA policy not found.');
    }
    return policy;
  });
}

export async function createCalendar(
  input: CreateCalendarInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<BusinessCalendar> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  if (await findBusinessCalendarByName(organizationId, input.name)) {
    throw new DuplicateError('A calendar with that name already exists.');
  }

  return runInTransaction(async (tx) => {
    const calendar = await createBusinessCalendar(
      {
        organizationId,
        name: input.name,
        timeZone: input.timeZone,
        model: input.model,
        workingHours: input.workingHours as Prisma.InputJsonValue,
        holidays: input.holidays as Prisma.InputJsonValue,
        version: 1,
      },
      tx,
    );

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.SLA_CALENDAR_CREATE,
        entityType: AUDIT_ENTITY.BUSINESS_CALENDAR,
        entityId: calendar.id,
        after: { name: calendar.name, timeZone: calendar.timeZone, model: calendar.model },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return calendar;
  });
}

export interface UpdateCalendarInput {
  name?: string;
  timeZone?: string;
  model?: SlaCalendarModel;
  workingHours?: Record<string, Array<{ start: string; end: string }>>;
  holidays?: string[];
}

/**
 * `PATCH /sla/calendars/{id}` — an edit is a **new version** (docs/25 §4 rule 6, §11).
 *
 * The rule that shapes this function: a calendar row is immutable once it exists, so the
 * edit writes version N+1 carrying the merged values, marks N superseded, and moves every
 * policy onto the successor — which is what makes "new records use the new version"
 * (docs/25 §13) true, since a policy is the only path from a new record to a calendar.
 * In-flight records are untouched either way: their `targetAt`/`warnAt` were frozen at
 * start and are never recomputed from current calendar data (§4 example 5), so a calendar
 * edit cannot move an existing deadline (§14 AC4).
 *
 * Only the *current* version is editable. Pointing an edit at a superseded row would fork
 * a lineage that has already moved on, and the client would be editing a version no new
 * record will ever use.
 */
export async function updateCalendar(
  id: string,
  input: UpdateCalendarInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<BusinessCalendar> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  const existing = await findBusinessCalendarById(id);
  if (!existing || existing.organizationId !== organizationId) {
    throw new NotFoundError('Business calendar not found.');
  }
  if (!existing.isActive) {
    throw new ConflictError(
      'This calendar version has been superseded. Edit the current version instead.',
    );
  }

  // A rename collides with any *other* calendar's name: names identify a calendar across
  // its versions, while the unique index only constrains (name, version).
  if (input.name !== undefined && input.name !== existing.name) {
    if (await findBusinessCalendarByName(organizationId, input.name)) {
      throw new DuplicateError('A calendar with that name already exists.');
    }
  }

  try {
    return await runInTransaction(async (tx) => {
      const next = await createBusinessCalendar(
        {
          organizationId,
          name: input.name ?? existing.name,
          timeZone: input.timeZone ?? existing.timeZone,
          model: input.model ?? existing.model,
          workingHours: (input.workingHours ?? existing.workingHours) as Prisma.InputJsonValue,
          holidays: (input.holidays ?? existing.holidays) as Prisma.InputJsonValue,
          version: existing.version + 1,
        },
        tx,
      );

      await supersedeBusinessCalendar(existing.id, tx);
      const policiesRepointed = await movePoliciesToCalendar(existing.id, next.id, tx);

      await writeAudit(
        {
          organizationId,
          actorId: actor.userId,
          actorType: 'USER',
          action: AUDIT_ACTION.SLA_CALENDAR_UPDATE,
          entityType: AUDIT_ENTITY.BUSINESS_CALENDAR,
          entityId: existing.id,
          before: {
            version: existing.version,
            name: existing.name,
            timeZone: existing.timeZone,
            model: existing.model,
          },
          after: {
            version: next.version,
            name: next.name,
            timeZone: next.timeZone,
            model: next.model,
            newCalendarId: next.id,
            policiesRepointed,
          },
          correlationId: meta.correlationId,
          sourceIp: meta.sourceIp ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );

      return next;
    });
  } catch (error) {
    // (organizationId, name, version) is unique: a concurrent edit raced for the same
    // version number. Read back as "the calendar changed under you", not as a 500.
    if (isUniqueViolation(error)) {
      throw new ConflictError('That calendar was edited concurrently. Reload and try again.');
    }
    throw error;
  }
}

export async function createPolicy(
  input: CreatePolicyInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<SlaPolicyWithTargets> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  await requireCalendar(input.calendarId, organizationId);
  if (await findSlaPolicyByName(organizationId, input.name)) {
    throw new DuplicateError('An SLA policy with that name already exists.');
  }

  return runInTransaction(async (tx) => {
    // Only one policy may be the tenant default (docs/25 §8 fallback resolution).
    if (input.isDefault) {
      await clearDefaultSlaPolicies(organizationId, null, tx);
    }

    const policy = await createSlaPolicy(
      {
        organizationId,
        name: input.name,
        calendarId: input.calendarId,
        pauseStates: input.pauseStates as Prisma.InputJsonValue,
        isActive: input.isActive,
        isDefault: input.isDefault,
        targets: input.targets,
      },
      tx,
    );

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.SLA_POLICY_CREATE,
        entityType: AUDIT_ENTITY.SLA_POLICY,
        entityId: policy.id,
        after: { name: policy.name, priorities: input.targets.map((target) => target.priority) },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return policy;
  });
}

export async function updatePolicy(
  id: string,
  input: {
    name?: string;
    calendarId?: string;
    pauseStates?: string[];
    isActive?: boolean;
    isDefault?: boolean;
    targets?: SlaTargetInput[];
  },
  actor: Principal,
  meta: RequestMeta,
): Promise<SlaPolicyWithTargets> {
  assertPermission(actor, MANAGE_PERMISSION);
  const organizationId = requireTenant(actor);

  const existing = await findSlaPolicyById(id);
  if (!existing || existing.organizationId !== organizationId) {
    throw new NotFoundError('SLA policy not found.');
  }

  if (input.calendarId) {
    await requireCalendar(input.calendarId, organizationId);
  }
  if (input.name && input.name !== existing.name) {
    if (await findSlaPolicyByName(organizationId, input.name)) {
      throw new DuplicateError('An SLA policy with that name already exists.');
    }
  }

  return runInTransaction(async (tx) => {
    if (input.isDefault) {
      await clearDefaultSlaPolicies(organizationId, id, tx);
    }

    const updated = await updateSlaPolicy(
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.calendarId !== undefined ? { calendarId: input.calendarId } : {}),
        ...(input.pauseStates !== undefined
          ? { pauseStates: input.pauseStates as Prisma.InputJsonValue }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...(input.targets !== undefined ? { targets: input.targets } : {}),
      },
      tx,
    );

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.SLA_POLICY_UPDATE,
        entityType: AUDIT_ENTITY.SLA_POLICY,
        entityId: id,
        before: { name: existing.name, isDefault: existing.isDefault },
        after: input as Prisma.InputJsonValue,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return updated;
  });
}

/**
 * Seeds a tenant's first calendar and default policy at provisioning.
 *
 * Without this a freshly provisioned tenant has no SLA policy, so no catalog item could
 * satisfy rule C1 and be activated — the tenant would be unusable until an administrator
 * configured SLA by hand. A working-hours default is seeded rather than a 24×7 one,
 * because ADR-0008 makes working hours the default and an always-on policy would
 * systematically misreport a business-hours desk.
 */
export async function seedTenantSlaDefaults(
  organizationId: string,
  timeZone: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const workingHours: Record<string, Array<{ start: string; end: string }>> = {
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
    wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }],
    fri: [{ start: '09:00', end: '17:00' }],
  };

  const calendar = await createBusinessCalendar(
    {
      organizationId,
      name: 'Default business hours',
      timeZone,
      model: 'WORKING_HOURS',
      workingHours: workingHours as Prisma.InputJsonValue,
      holidays: [] as Prisma.InputJsonValue,
      version: 1,
    },
    tx,
  );

  await createSlaPolicy(
    {
      organizationId,
      name: 'Default',
      calendarId: calendar.id,
      pauseStates: ['APPROVAL_PENDING'] as Prisma.InputJsonValue,
      isActive: true,
      isDefault: true,
      // Response/resolution minutes by priority, in working minutes (docs/25 §2).
      targets: [
        { priority: 'LOW', responseMinutes: 480, resolveMinutes: 2880, warnPercent: 75 },
        { priority: 'MEDIUM', responseMinutes: 240, resolveMinutes: 1440, warnPercent: 75 },
        { priority: 'HIGH', responseMinutes: 120, resolveMinutes: 480, warnPercent: 75 },
        { priority: 'CRITICAL', responseMinutes: 60, resolveMinutes: 240, warnPercent: 75 },
      ],
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Clocks: read and override (docs/25 §11, §12)
// ---------------------------------------------------------------------------

/**
 * Reading and overriding a clock is SLA administration, not record lifecycle.
 *
 * The distinction matters for where the code lives and who may call it. Start, pause,
 * resume and stop belong to the record's own transitions — a request cannot be fulfilled
 * without stopping its clock — so those live with requests and incidents
 * (`sla-clock.service.ts`). A clock **read** and an **override**, by contrast, are acts
 * *on the SLA itself*: an authorised actor moving a target or clearing a breach. They are
 * therefore served from `/sla/clocks/...` (§11) and audited as SLA events, while still
 * being scoped to the record the clock belongs to — the object-level rule applies exactly
 * as it does on a direct read (`docs/07` §1, `docs/17`).
 */

const CLOCK_OVERRIDE_PERMISSION = 'sla:clock:override';

export interface ClockOverrideInput {
  /** Mandatory: an override without a recorded reason is not an override (`docs/25` §11). */
  reason: string;
  /** New frozen target instant, ISO 8601. Moving it earlier can put the clock at risk at once. */
  targetAt?: string;
  /** Clears `breachedAt`. The breach itself stays in the audit trail (`docs/25` §14 AC6). */
  clearBreach?: boolean;
}

/** `GET /sla/clocks/{id}` — the clock for a record the caller may see. */
export async function getClock(id: string, actor: Principal): Promise<SlaClockView> {
  const clock = await loadVisibleClock(id, actor);
  return describeClock(clock);
}

/**
 * `POST /sla/clocks/{id}/override` — an explicit, audited correction (`docs/25` §11, §14
 * AC8).
 *
 * Two things this deliberately does **not** do:
 *
 *   - It does not recompute a target from the policy. The frozen-target rule (§4 example
 *     5) exists so a policy edit cannot rewrite history; a human override moves the
 *     instant by hand and says why, which is a different act with a different audit entry.
 *   - It does not erase a breach. `breachedAt` is cleared only as its own explicit request,
 *     and the audit entry keeps the before-state, so "the breach happened and was cleared"
 *     is never misread as "there was no breach" (§6, AC6).
 */
export async function overrideClock(
  id: string,
  input: ClockOverrideInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<SlaClockView> {
  assertPermission(actor, CLOCK_OVERRIDE_PERMISSION);
  const clock = await loadVisibleClock(id, actor);
  const now = new Date();

  let targetAt = clock.targetAt;
  let warnAt = clock.warnAt;
  if (input.targetAt) {
    targetAt = new Date(input.targetAt);
    // The warn threshold keeps its margin from the target rather than its absolute
    // instant: an override moves the deadline, so the point at which the clock turns
    // AT_RISK has to move with it or the warning fires at the wrong time.
    const marginMs = Math.max(0, clock.targetAt.getTime() - clock.warnAt.getTime());
    warnAt = new Date(targetAt.getTime() - marginMs);
  }

  const breachedAt = input.clearBreach ? null : clock.breachedAt;
  const state = deriveState({
    now,
    paused: clock.pausedAt !== null,
    breached: breachedAt !== null,
    warnAt,
    targetAt,
    stopped: clock.stoppedAt !== null,
  });

  const view = await runInTransaction(async (tx) => {
    const updated = await updateSlaClockOverride(
      clock.id,
      {
        ...(input.targetAt ? { targetAt, warnAt } : {}),
        ...(input.clearBreach ? { breachedAt: null } : {}),
        state,
      },
      tx,
    );

    await writeAudit(
      {
        organizationId: clock.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.SLA_CLOCK_OVERRIDE,
        entityType: AUDIT_ENTITY.SLA_CLOCK,
        entityId: clock.id,
        reason: input.reason,
        before: {
          targetAt: clock.targetAt.toISOString(),
          warnAt: clock.warnAt.toISOString(),
          breachedAt: clock.breachedAt?.toISOString() ?? null,
          state: clock.state,
        },
        after: {
          targetAt: targetAt.toISOString(),
          warnAt: warnAt.toISOString(),
          breachedAt: breachedAt?.toISOString() ?? null,
          state,
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return describeClock(updated, now);
  });

  // Post-commit (`docs/30` §3.4): moving a target or clearing a breach changes the stored
  // attainment figure, which is read from the clock state, never recomputed (`§3.2` R1).
  await invalidateReportCache(clock.organizationId, 'report.sla');

  return view;
}

/**
 * Loads a clock the caller is allowed to see.
 *
 * A clock inherits its record's visibility exactly: same tenant, same object-level rule
 * (`07` §1). An out-of-scope, cross-tenant or orphaned clock is NOT_FOUND rather than
 * FORBIDDEN, so the endpoint cannot be used to probe for record ids (`docs/17`).
 */
async function loadVisibleClock(id: string, actor: Principal): Promise<SlaClock> {
  const organizationId = requireTenant(actor);
  const clock = await findSlaClockById(id);
  if (!clock || clock.organizationId !== organizationId) {
    throw new NotFoundError('SLA clock not found.');
  }

  if (clock.entityType === 'ServiceRequest') {
    await assertRequestVisible(clock.entityId, actor);
  } else if (clock.entityType === 'Incident') {
    await assertIncidentVisible(clock.entityId, actor);
  } else {
    // An unrecognised entity type is a data defect, not a caller error. Refusing is the
    // only safe answer: it must not become a way to read a clock without its record's
    // scope check.
    throw new NotFoundError('SLA clock not found.');
  }

  return clock;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can manage SLA configuration.');
  }
  return actor.organizationId;
}

/** Prisma's unique-constraint error (`P2002`), read without importing Prisma itself. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

async function requireCalendar(
  calendarId: string,
  organizationId: string,
): Promise<BusinessCalendar> {
  const calendar = await findBusinessCalendarById(calendarId);
  if (!calendar || calendar.organizationId !== organizationId) {
    throw new NotFoundError('Business calendar not found.');
  }
  return calendar;
}
