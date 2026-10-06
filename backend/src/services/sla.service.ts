import type { BusinessCalendar, Prisma, SlaCalendarModel } from '@prisma/client';
import { assertPermission, type Principal } from '../helpers/authorization';
import { ForbiddenError, NotFoundError, DuplicateError } from '../utils/errors';
import {
  clearDefaultSlaPolicies,
  createBusinessCalendar,
  createSlaPolicy,
  findBusinessCalendarById,
  findBusinessCalendarByName,
  findSlaPolicyById,
  findSlaPolicyByName,
  listBusinessCalendars,
  listSlaPolicies,
  runInTransaction,
  updateSlaPolicy,
  writeAudit,
  type SlaPolicyWithTargets,
  type SlaTargetInput,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

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
// Internals
// ---------------------------------------------------------------------------

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can manage SLA configuration.');
  }
  return actor.organizationId;
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
