import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addWorkingMinutes, type CalendarSpec } from '../src/helpers/calendar';
import {
  disconnectDatabase,
  findSlaPolicyById,
  prisma,
  runInTransaction,
  updateSlaPolicy,
  type SlaPolicyWithTargets,
} from '../src/models';
import { deriveState, pauseClockIfPolicy, resumeClock, startClock } from '../src/services';

/**
 * The SLA worked examples of docs/25 §4, asserted directly (acceptance criterion §14.1).
 *
 * Model A, calendar Mon–Fri 09:00–17:00, Europe/London. Examples 1, 3 and 4 are pure
 * calendar arithmetic and are exercised through `addWorkingMinutes`; example 2's rule
 * (an approval wait is excluded, and the remaining budget is preserved) and example 5's
 * (targets are computed at start and frozen) need the clock mechanics, so they run
 * against a real database.
 *
 * **Documentation discrepancy (example 2).** §4 states the result as *Thu 15:00*, but its
 * own stated inputs ("2 hours elapsed before pause; resumes Wed 09:00") yield **Wed
 * 15:00** — 8 working hours less the 2 consumed before the pause, resumed on Wednesday.
 * The stated date does not follow from the stated inputs, so this suite asserts the
 * **rule** (the remaining budget is exactly preserved) rather than the disputed literal.
 * The discrepancy is recorded for the owner; the engine is not silently bent to match it.
 */

const LONDON_MON_FRI: CalendarSpec = {
  timeZone: 'Europe/London',
  model: 'WORKING_HOURS',
  workingHours: {
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
    wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }],
    fri: [{ start: '09:00', end: '17:00' }],
  },
  holidays: [],
};

/** Local wall-clock rendering of an instant in a zone, for readable assertions. */
function local(instant: Date, timeZone = 'Europe/London'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

describe('docs/25 §4 worked examples — calendar arithmetic (Model A)', () => {
  it('example 1: an 8-working-hour target created Fri 16:00 lands Mon 16:00', () => {
    // 2026-03-06 is a Friday; Europe/London is GMT until 29 March, so no DST in the way.
    const target = addWorkingMinutes(new Date('2026-03-06T16:00:00Z'), 480, LONDON_MON_FRI);
    expect(local(target)).toBe('2026-03-09 16:00');
  });

  it('example 2: an approval wait is excluded and the remaining budget is preserved', () => {
    // Created Mon 10:00; 2 working hours elapse before the pause (Mon 10:00 → 12:00);
    // the clock resumes Wed 09:00 with 8 − 2 = 6 working hours still to run.
    const resumeAt = new Date('2026-03-11T09:00:00Z'); // Wed 09:00 London
    const target = addWorkingMinutes(resumeAt, 480 - 120, LONDON_MON_FRI);

    // 6 working hours from Wed 09:00 → Wed 15:00 (the instant the §4 inputs imply).
    expect(local(target)).toBe('2026-03-11 15:00');
    expect(target.getTime() - resumeAt.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it('example 3: a public holiday contributes zero and shifts the target one working day', () => {
    const calendar: CalendarSpec = { ...LONDON_MON_FRI, holidays: ['2026-03-10'] };
    const target = addWorkingMinutes(new Date('2026-03-09T10:00:00Z'), 480, calendar);
    // Tue 10 March is a holiday, so the remaining minutes roll to Wednesday.
    expect(local(target)).toBe('2026-03-11 10:00');
  });

  it('example 4: DST is handled by calendar arithmetic, not a fixed offset', () => {
    // 2026-03-29 is the London spring-forward: the local day is 23 hours long, so a
    // 00:00–04:00 window is only three real hours. Fixed-offset math would say four.
    const calendar: CalendarSpec = {
      timeZone: 'Europe/London',
      model: 'WORKING_HOURS',
      workingHours: { sun: [{ start: '00:00', end: '04:00' }] },
      holidays: [],
    };
    const start = new Date('2026-03-29T00:00:00Z');
    const target = addWorkingMinutes(start, 180, calendar);
    expect(local(target)).toBe('2026-03-29 04:00');
    expect(target.getTime() - start.getTime()).toBe(3 * 60 * 60 * 1000);
  });
});

let databaseAvailable = false;

function dbIt(name: string, fn: () => Promise<void> | void): void {
  it(name, async (ctx) => {
    if (!databaseAvailable) {
      ctx.skip();
    }
    await fn();
  });
}

async function createPolicyFixture(suffix: string): Promise<SlaPolicyWithTargets> {
  const organization = await prisma.organization.create({
    data: {
      name: `SLA Examples ${suffix}`,
      nameKey: `sla examples ${suffix}`,
      slug: `sla-examples-${suffix}`,
      defaultTimeZone: 'Europe/London',
    },
  });
  const calendar = await prisma.businessCalendar.create({
    data: {
      organizationId: organization.id,
      name: 'Business hours',
      timeZone: 'Europe/London',
      model: 'WORKING_HOURS',
      workingHours: LONDON_MON_FRI.workingHours as unknown as object,
      holidays: [],
    },
  });
  const policy = await prisma.slaPolicy.create({
    data: {
      organizationId: organization.id,
      name: 'Default',
      calendarId: calendar.id,
      pauseStates: ['APPROVAL_PENDING'],
      isActive: true,
      isDefault: true,
      targets: {
        create: [{ priority: 'HIGH', responseMinutes: 120, resolveMinutes: 480, warnPercent: 75 }],
      },
    },
  });

  const withTargets = await findSlaPolicyById(policy.id);
  if (!withTargets) throw new Error('Policy fixture was not created.');
  return withTargets;
}

describe('docs/25 §4 worked examples — clock mechanics', () => {
  beforeAll(async () => {
    try {
      await prisma.organization.count();
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
    }
  });

  afterAll(async () => {
    await disconnectDatabase().catch(() => undefined);
  });

  dbIt(
    'example 2 (rule): a pause is excluded exactly once (AC2) and freezes the clock',
    async () => {
      const policy = await createPolicyFixture(`pause-${Date.now()}`);

      const startedAt = new Date('2026-03-09T10:00:00Z'); // Mon 10:00 London
      const pausedAt = new Date('2026-03-09T12:00:00Z'); // Mon 12:00
      const resumedAt = new Date('2026-03-09T14:00:00Z'); // Mon 14:00, same working day

      const clock = await runInTransaction(async (tx) => {
        const created = await startClock(
          {
            organizationId: policy.organizationId,
            entityType: 'ServiceRequest',
            entityId: 'example-2',
            slaPolicy: policy,
            priority: 'HIGH',
            startAt: startedAt,
          },
          tx,
        );
        await pauseClockIfPolicy(
          'ServiceRequest',
          'example-2',
          'APPROVAL_PENDING',
          policy,
          pausedAt,
          tx,
        );
        // While paused the clock is frozen: state derives to PAUSED, not BREACHED/AT_RISK.
        const paused = await tx.slaClock.findFirstOrThrow({ where: { id: created.id } });
        await resumeClock('ServiceRequest', 'example-2', resumedAt, tx);
        return paused;
      });

      expect(clock.state).toBe('PAUSED');

      const resumed = await prisma.slaClock.findFirstOrThrow({ where: { id: clock.id } });
      // The pause consumed 2 hours of the budget, so the target moved out by exactly two
      // hours of working time: Tue 10:00 → Tue 12:00. Never counted twice (AC2).
      expect(resumed.totalPausedSeconds).toBe(2 * 60 * 60);
      expect(local(resumed.targetAt)).toBe('2026-03-10 12:00');
      expect(resumed.targetAt.getTime()).toBe(
        addWorkingMinutes(resumedAt, 480 - 120, LONDON_MON_FRI).getTime(),
      );
      expect(resumed.state).toBe(
        deriveState({
          now: resumedAt,
          paused: false,
          breached: false,
          warnAt: resumed.warnAt,
          targetAt: resumed.targetAt,
        }),
      );
    },
  );

  dbIt(
    'example 5: editing a policy never rewrites an in-flight clock (AC4, frozen target)',
    async () => {
      const policy = await createPolicyFixture(`freeze-${Date.now()}`);
      const startedAt = new Date('2026-03-09T10:00:00Z'); // Mon 10:00 London

      const inFlight = await runInTransaction(async (tx) =>
        startClock(
          {
            organizationId: policy.organizationId,
            entityType: 'ServiceRequest',
            entityId: 'example-5-existing',
            slaPolicy: policy,
            priority: 'HIGH',
            startAt: startedAt,
          },
          tx,
        ),
      );

      // 8 working hours from Mon 10:00 → Tue 10:00.
      expect(local(inFlight.targetAt)).toBe('2026-03-10 10:00');
      const frozenTarget = inFlight.targetAt.getTime();

      // An administrator tightens the policy (a new, shorter target). Under the frozen-target
      // rule this must not move the clock that already started.
      await updateSlaPolicy(policy.id, {
        targets: [{ priority: 'HIGH', responseMinutes: 60, resolveMinutes: 60, warnPercent: 75 }],
      });

      const reread = await prisma.slaClock.findFirstOrThrow({ where: { id: inFlight.id } });
      expect(reread.targetAt.getTime()).toBe(frozenTarget);

      // A record started *after* the edit uses the new target (Mon 11:00).
      const afterEdit = await runInTransaction(async (tx) => {
        const reloaded = await findSlaPolicyById(policy.id);
        if (!reloaded) throw new Error('Policy disappeared.');
        return startClock(
          {
            organizationId: policy.organizationId,
            entityType: 'ServiceRequest',
            entityId: 'example-5-new',
            slaPolicy: reloaded,
            priority: 'HIGH',
            startAt: startedAt,
          },
          tx,
        );
      });
      expect(local(afterEdit.targetAt)).toBe('2026-03-09 11:00');
    },
  );
});
