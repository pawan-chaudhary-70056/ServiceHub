import type { Prisma, Priority, SlaClock, SlaClockState } from '@prisma/client';
import {
  addWorkingMinutes,
  workingMinutesBetween,
  type CalendarSpec,
  type WorkingWindow,
} from '../helpers/calendar';
import {
  createSlaClock,
  findOpenSlaClock,
  findSlaPolicyById,
  listOpenSlaClocksForEntities,
  pauseSlaClock,
  resumeSlaClock,
  stopSlaClock,
  type SlaPolicyWithTargets,
} from '../models';
import { NotFoundError } from '../utils/errors';

/**
 * SLA clock mechanics — docs/25 §3.
 *
 * A clock's **target instants are computed once, at start, and frozen** (docs/25 §4
 * example 5). That is what makes attainment reproducible: a later policy or calendar edit
 * cannot retroactively change a record's target. This module therefore never recomputes
 * targets on a read path.
 *
 * `state` is a derived cache for list rendering (docs/25 §5); it is refreshed by the sweep
 * and never set from the API.
 */

/** The parent record type a clock observes. */
export type ClockEntityType = 'ServiceRequest' | 'Incident';

function toCalendarSpec(policy: SlaPolicyWithTargets): CalendarSpec {
  const calendar = policy.calendar;
  return {
    timeZone: calendar.timeZone,
    model: calendar.model,
    workingHours: (calendar.workingHours ?? {}) as unknown as Record<string, WorkingWindow[]>,
    holidays: (calendar.holidays ?? []) as unknown as string[],
  };
}

/**
 * Starts the clock for a new record. Throws when the policy has no target for the
 * priority — a configuration defect that must be surfaced, not silently turned into a
 * record with no SLA (docs/25 §8).
 */
export async function startClock(
  input: {
    organizationId: string;
    entityType: ClockEntityType;
    entityId: string;
    slaPolicy: SlaPolicyWithTargets;
    priority: Priority;
    startAt: Date;
    /** Cycle number; > 1 for a clock started by a reopen (`docs/25` §3). */
    cycle?: number;
  },
  tx: Prisma.TransactionClient,
): Promise<SlaClock> {
  const target = input.slaPolicy.targets.find((candidate) => candidate.priority === input.priority);
  if (!target) {
    throw new NotFoundError(`The SLA policy has no target for priority ${input.priority}.`);
  }

  const calendar = toCalendarSpec(input.slaPolicy);
  const targetAt = addWorkingMinutes(input.startAt, target.resolveMinutes, calendar);
  const warnAt = addWorkingMinutes(
    input.startAt,
    Math.floor((target.resolveMinutes * target.warnPercent) / 100),
    calendar,
  );

  return createSlaClock(
    {
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      slaPolicyId: input.slaPolicy.id,
      priority: input.priority,
      cycle: input.cycle ?? 1,
      startedAt: input.startAt,
      targetAt,
      warnAt,
      state: deriveState({ now: input.startAt, paused: false, breached: false, warnAt, targetAt }),
    },
    tx,
  );
}

/**
 * Stops the record's open clock at fulfilment/resolution (docs/25 §3). Idempotent: with
 * no open clock the call is a no-op, so a repeated transition cannot stop twice.
 */
export async function stopClock(
  entityType: ClockEntityType,
  entityId: string,
  stopAt: Date,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const clock = await findOpenSlaClock(entityType, entityId, tx);
  if (!clock) {
    return;
  }
  await stopSlaClock(clock.id, stopAt, tx);
}

/**
 * Pauses a record's running clock if the policy declares its new state a pause state
 * (docs/25 §3, §4). A policy with no pause states keeps the clock running during an
 * approval — a deliberate choice that the UI surfaces as "SLA running during approval".
 *
 * Idempotent: a clock already paused is left alone, so re-entering a pause state cannot
 * restart the pause interval.
 */
export async function pauseClockIfPolicy(
  entityType: ClockEntityType,
  entityId: string,
  state: string,
  policy: SlaPolicyWithTargets,
  pauseAt: Date,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const pauseStates = Array.isArray(policy.pauseStates) ? (policy.pauseStates as string[]) : [];
  if (!pauseStates.includes(state)) {
    return;
  }
  const clock = await findOpenSlaClock(entityType, entityId, tx);
  if (!clock || clock.pausedAt) {
    return;
  }
  await pauseSlaClock(clock.id, pauseAt, tx);
}

/**
 * Resumes a paused clock, pushing its target instants out by the paused duration and
 * accumulating the paused time (docs/25 §3). Idempotent: a clock that is not paused is
 * left alone, so leaving a pause state twice cannot double-count.
 *
 * The target is shifted, not recomputed, so the frozen-target rule (§4 example 5) holds.
 *
 * **The shift is by *working* minutes, not wall-clock minutes (docs/25 §14 AC2).** Under a
 * working-hours calendar the clock has already been frozen through the pause's nights and
 * weekends; adding the pause's wall-clock length would exclude that closed time a second
 * time — the double-counting AC2 forbids, and the error that silently grants a desk extra
 * SLA budget for an overnight approval wait. A 24×7 calendar has no frozen time, so its
 * working minutes are the wall-clock minutes.
 */
export async function resumeClock(
  entityType: ClockEntityType,
  entityId: string,
  resumeAt: Date,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const clock = await findOpenSlaClock(entityType, entityId, tx);
  if (!clock || !clock.pausedAt) {
    return;
  }

  // The clock's own policy calendar decides what counts as working time. Loading it here
  // keeps the frozen-target rule intact: only the *shift* uses the calendar, never a
  // recomputation of the target from the policy's current targets.
  const policy = await findSlaPolicyById(clock.slaPolicyId, tx);
  const pausedMinutes = policy
    ? workingMinutesBetween(clock.pausedAt, resumeAt, toCalendarSpec(policy))
    : Math.floor((resumeAt.getTime() - clock.pausedAt.getTime()) / 60_000);
  const pausedSeconds = Math.max(0, pausedMinutes) * 60;

  const newState = deriveState({
    now: resumeAt,
    paused: false,
    breached: clock.breachedAt !== null,
    warnAt: new Date(clock.warnAt.getTime() + pausedSeconds * 1000),
    targetAt: new Date(clock.targetAt.getTime() + pausedSeconds * 1000),
  });
  await resumeSlaClock(
    clock.id,
    {
      totalPausedSeconds: clock.totalPausedSeconds + pausedSeconds,
      targetAt: new Date(clock.targetAt.getTime() + pausedSeconds * 1000),
      warnAt: new Date(clock.warnAt.getTime() + pausedSeconds * 1000),
      state: newState === 'PAUSED' ? 'ON_TRACK' : newState,
    },
    tx,
  );
}

/** Which state a clock is in now, derived from stored timestamps (docs/25 §5). */
export function deriveState(clock: {
  now: Date;
  paused: boolean;
  breached: boolean;
  warnAt: Date;
  targetAt: Date;
  stopped?: boolean;
}): SlaClockState {
  if (clock.stopped) return 'STOPPED';
  if (clock.paused) return 'PAUSED';
  if (clock.breached) return 'BREACHED';
  if (clock.now >= clock.warnAt) return 'AT_RISK';
  return 'ON_TRACK';
}

/**
 * The clock as every read surface publishes it (`docs/25` §5, §12).
 *
 * `state` here is **derived from the stored timestamps at read time**, not read from the
 * `state` column: the column is the sweep's cache for querying and is stale by up to one
 * interval, and a countdown that disagrees with its own badge is worse than no countdown
 * (`docs/25` §5 makes the derivation authoritative, the column a cache).
 */
export interface SlaClockView {
  id: string;
  cycle: number;
  priority: Priority;
  state: SlaClockState;
  startedAt: Date;
  targetAt: Date;
  warnAt: Date;
  breachedAt: Date | null;
  pausedAt: Date | null;
  stoppedAt: Date | null;
  totalPausedSeconds: number;
  /**
   * Seconds until the frozen target instant; negative once it has passed.
   *
   * Deliberately wall-clock, not working time: `targetAt` is already the result of
   * calendar arithmetic, so the distance to it is the literal time left before breach —
   * and the arithmetic to restate it in working minutes belongs to the calendar, which a
   * list read must not pay for per row. A record with no open clock has no SLA view at
   * all rather than a zero one (`docs/25` §12).
   */
  remainingSeconds: number;
}

/** Projects one clock for an API response. */
export function describeClock(clock: SlaClock, now: Date = new Date()): SlaClockView {
  return {
    id: clock.id,
    cycle: clock.cycle,
    priority: clock.priority,
    state: deriveState({
      now,
      paused: clock.pausedAt !== null,
      breached: clock.breachedAt !== null,
      warnAt: clock.warnAt,
      targetAt: clock.targetAt,
      stopped: clock.stoppedAt !== null,
    }),
    startedAt: clock.startedAt,
    targetAt: clock.targetAt,
    warnAt: clock.warnAt,
    breachedAt: clock.breachedAt,
    pausedAt: clock.pausedAt,
    stoppedAt: clock.stoppedAt,
    totalPausedSeconds: clock.totalPausedSeconds,
    remainingSeconds: Math.round((clock.targetAt.getTime() - now.getTime()) / 1000),
  };
}

/**
 * The live clock views for a set of records, keyed by record id.
 *
 * One query for the whole page (`models/sla.model.ts`), so a list can show an SLA
 * indicator per row without an N+1 (`docs/25` §12, `docs/33` §7).
 */
export async function clockViewsFor(
  organizationId: string,
  entityType: ClockEntityType,
  entityIds: string[],
  now: Date = new Date(),
): Promise<Map<string, SlaClockView>> {
  const clocks = await listOpenSlaClocksForEntities(organizationId, entityType, entityIds);
  const views = new Map<string, SlaClockView>();
  for (const clock of clocks) {
    // Newest cycle wins: a reopened record has one live clock, and `orderBy cycle desc`
    // guarantees the first row seen for an entity is the current one.
    if (!views.has(clock.entityId)) {
      views.set(clock.entityId, describeClock(clock, now));
    }
  }
  return views;
}

/** The live clock view for one record, or null when it has none. */
export async function clockViewFor(
  organizationId: string,
  entityType: ClockEntityType,
  entityId: string,
  now: Date = new Date(),
): Promise<SlaClockView | null> {
  const clocks = await listOpenSlaClocksForEntities(organizationId, entityType, [entityId]);
  // One live clock per record: the query is `cycle desc`, and a reopened record's previous
  // cycle is stopped, so the first row is the current one.
  const clock = clocks[0];
  return clock ? describeClock(clock, now) : null;
}
