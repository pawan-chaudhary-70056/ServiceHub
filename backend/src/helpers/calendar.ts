/**
 * Business-calendar arithmetic (docs/25 §4, ADR-0008).
 *
 * The only thing this module does is answer: *given a start instant and N working
 * minutes, what later instant is N working minutes away?* It is a pure leaf module —
 * no database, no HTTP — so it is unit-testable with an injected start and no clock.
 *
 * Correctness rules it implements (docs/25 §4):
 *   1. All arithmetic happens in the calendar's declared time zone, not the server's.
 *   2. Time advances only inside working windows; outside them it is frozen.
 *   3. Holidays are excluded as whole non-working days.
 *   4. Daylight saving is handled by calendar arithmetic (local wall-time → instant),
 *      never by adding a fixed offset — a naive +8h on a DST day is an hour wrong twice
 *      a year, and those errors land in reporting (§4 rule 5).
 */

export interface WorkingWindow {
  /** HH:MM in the calendar's time zone. */
  start: string;
  /** HH:MM in the calendar's time zone, exclusive. */
  end: string;
}

export interface CalendarSpec {
  timeZone: string;
  model: 'WORKING_HOURS' | 'WALL_CLOCK';
  workingHours: Record<string, WorkingWindow[]>;
  /** ISO `YYYY-MM-DD` dates excluded entirely. */
  holidays: string[];
}

const MINUTE_MS = 60_000;
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: string; // mon..sun
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '0';

  const weekdayLabel = get('weekday').toLowerCase().slice(0, 3);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_KEYS.includes(weekdayLabel as (typeof WEEKDAY_KEYS)[number])
      ? weekdayLabel
      : 'mon',
  };
}

/** UTC offset, in milliseconds, of the zone at a given instant. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = localParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asIfUtc - instant.getTime();
}

/**
 * Converts a local wall time in a zone to a UTC instant, accounting for DST.
 *
 * The offset is guessed, applied, then refined once — enough because an offset changes by
 * at most an hour at a transition and the refinement lands on the correct side.
 */
function localToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guess = offsetMs(new Date(wallUtc), timeZone);
  const refined = offsetMs(new Date(wallUtc - guess), timeZone);
  return new Date(wallUtc - refined);
}

function dateKey(parts: LocalParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Returns the instant that is `minutes` working minutes after `start`.
 *
 * A 24×7 calendar is a straight addition. A working-hours calendar walks forward day by
 * day, consuming each working window in turn, skipping holidays, until the budget is
 * spent. The walk is bounded, so a pathological calendar cannot loop forever.
 */
export function addWorkingMinutes(start: Date, minutes: number, calendar: CalendarSpec): Date {
  if (calendar.model === 'WALL_CLOCK' || minutes <= 0) {
    return new Date(start.getTime() + Math.max(0, minutes) * MINUTE_MS);
  }

  let remaining = minutes;
  let cursor = start;
  const holidaySet = new Set(calendar.holidays);

  for (let day = 0; day < 730; day += 1) {
    const parts = localParts(cursor, calendar.timeZone);

    if (holidaySet.has(dateKey(parts))) {
      cursor = localToInstant(parts.year, parts.month, parts.day + 1, 0, 0, calendar.timeZone);
      continue;
    }

    const windows = [...(calendar.workingHours[parts.weekday] ?? [])].sort(
      (a, b) => minutesOfDay(a.start) - minutesOfDay(b.start),
    );

    for (const window of windows) {
      const windowStart = localToInstant(
        parts.year,
        parts.month,
        parts.day,
        Math.floor(minutesOfDay(window.start) / 60),
        minutesOfDay(window.start) % 60,
        calendar.timeZone,
      );
      const windowEnd = localToInstant(
        parts.year,
        parts.month,
        parts.day,
        Math.floor(minutesOfDay(window.end) / 60),
        minutesOfDay(window.end) % 60,
        calendar.timeZone,
      );

      if (!(cursor < windowEnd)) {
        continue;
      }

      const effectiveStart = cursor > windowStart ? cursor : windowStart;
      const available = (windowEnd.getTime() - effectiveStart.getTime()) / MINUTE_MS;

      if (remaining <= available) {
        return new Date(effectiveStart.getTime() + remaining * MINUTE_MS);
      }

      remaining -= available;
      cursor = windowEnd;
    }

    cursor = localToInstant(parts.year, parts.month, parts.day + 1, 0, 0, calendar.timeZone);
  }

  // A calendar with no working windows can never satisfy the budget; return the start so
  // callers get a deterministic, non-crashing value. The configuration defect is the bug.
  return start;
}
