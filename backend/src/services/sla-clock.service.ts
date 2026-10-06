import type { Prisma, Priority, SlaClock, SlaClockState } from '@prisma/client';
import { addWorkingMinutes, type CalendarSpec, type WorkingWindow } from '../helpers/calendar';
import {
  createSlaClock,
  findOpenSlaClock,
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
  const pausedSeconds = Math.max(
    0,
    Math.floor((resumeAt.getTime() - clock.pausedAt.getTime()) / 1000),
  );
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
