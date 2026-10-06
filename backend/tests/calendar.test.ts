import { describe, expect, it } from 'vitest';
import { addWorkingMinutes, type CalendarSpec } from '../src/helpers/calendar';

/**
 * Business-calendar arithmetic (docs/25 §4). These are the **worked examples** the SLA
 * document commits to, asserted directly so the semantics cannot drift:
 *
 *   1. a weekend contributes zero elapsed time;
 *   2. only working windows advance the clock;
 *   3. a holiday shifts the target by one working day;
 *   4. daylight saving is handled by calendar arithmetic, not fixed offsets.
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
function local(instant: Date, timeZone: string): string {
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

describe('addWorkingMinutes', () => {
  it('skips a weekend: Fri 16:00 + 8 working hours lands Mon 16:00 (example 1)', () => {
    // 2026-03-06 is a Friday; London is GMT until 29 March.
    const start = new Date('2026-03-06T16:00:00Z');
    const target = addWorkingMinutes(start, 480, LONDON_MON_FRI);

    expect(local(target, 'Europe/London')).toBe('2026-03-09 16:00');
  });

  it('advances only inside working windows: Mon 10:00 + 8h lands Tue 10:00 (example 2)', () => {
    const start = new Date('2026-03-09T10:00:00Z');
    const target = addWorkingMinutes(start, 480, LONDON_MON_FRI);

    expect(local(target, 'Europe/London')).toBe('2026-03-10 10:00');
  });

  it('excludes a holiday as a whole non-working day (example 3)', () => {
    const calendar: CalendarSpec = { ...LONDON_MON_FRI, holidays: ['2026-03-10'] };
    const start = new Date('2026-03-09T10:00:00Z');
    const target = addWorkingMinutes(start, 480, calendar);

    expect(local(target, 'Europe/London')).toBe('2026-03-11 10:00');
  });

  it('handles the spring-forward transition by wall time, not a fixed offset (example 4)', () => {
    // Europe/London moves 01:00 → 02:00 on 2026-03-29, so a 00:00–04:00 window that day
    // is only three real hours. A naive +offset implementation would report four.
    const calendar: CalendarSpec = {
      timeZone: 'Europe/London',
      model: 'WORKING_HOURS',
      workingHours: { sun: [{ start: '00:00', end: '04:00' }] },
      holidays: [],
    };
    const start = new Date('2026-03-29T00:00:00Z');
    const target = addWorkingMinutes(start, 180, calendar);

    expect(local(target, 'Europe/London')).toBe('2026-03-29 04:00');
    expect(target.getTime() - start.getTime()).toBe(3 * 60 * 60 * 1000);
  });

  it('treats a 24x7 calendar as a straight addition', () => {
    const calendar: CalendarSpec = {
      timeZone: 'UTC',
      model: 'WALL_CLOCK',
      workingHours: {},
      holidays: [],
    };
    const start = new Date('2026-03-06T16:00:00Z');
    const target = addWorkingMinutes(start, 90, calendar);

    expect(target.toISOString()).toBe('2026-03-06T17:30:00.000Z');
  });
});
