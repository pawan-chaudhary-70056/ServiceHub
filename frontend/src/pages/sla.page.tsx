import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  createCalendar,
  createPolicy,
  listCalendars,
  listPolicies,
  updateCalendar,
  updatePolicy,
  type BusinessCalendar,
  type CreateCalendarInput,
  type PolicyInput,
  type SlaPolicy,
  type SlaTargetInput,
} from '../api/sla.api';
import type { Priority } from '../api/catalog.api';
import { StatusBadge } from '../components/status-badge';

/**
 * SLA administration (`docs/25` §12) — the policy list, the target matrix by priority and
 * the calendar editor.
 *
 * Three rules from the document shape this screen:
 *
 *   - **The target matrix is the policy.** A priority with no target is a record that cannot
 *     be given an SLA, so the form always shows all four priorities and refuses to submit one
 *     without a resolve target (`docs/25` §2).
 *   - **A calendar a clock references is history.** Editing one is a *new version* rather than
 *     an edit of the row in-flight records were computed against (§4 rule 6) — which is why
 *     this screen saves an edit as version N+1, supersedes the old row and lets the server
 *     move policies onto the successor. The row itself is never rewritten.
 *   - **A policy edit cannot move an existing deadline.** Every clock stores the target
 *     instants computed at its start, so editing here is safe by construction (§4 example 5).
 */

const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** The record states a policy may pause the clock on (`docs/25` §3). */
const PAUSE_STATES = [
  'NEW',
  'TRIAGED',
  'APPROVAL_PENDING',
  'APPROVED',
  'REJECTED',
  'IN_PROGRESS',
  'FULFILLED',
] as const;

const WEEKDAYS: Array<{ key: string; label: string }> = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

interface TargetDraft {
  responseMinutes: string;
  resolveMinutes: string;
  warnPercent: string;
}

function defaultTargets(): Record<Priority, TargetDraft> {
  return {
    LOW: { responseMinutes: '480', resolveMinutes: '2880', warnPercent: '75' },
    MEDIUM: { responseMinutes: '240', resolveMinutes: '1440', warnPercent: '75' },
    HIGH: { responseMinutes: '120', resolveMinutes: '480', warnPercent: '75' },
    CRITICAL: { responseMinutes: '60', resolveMinutes: '240', warnPercent: '75' },
  };
}

export function SlaPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const policies = useQuery({
    queryKey: ['sla', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
  });
  const calendars = useQuery({
    queryKey: ['sla', 'calendars'],
    queryFn: ({ signal }) => listCalendars(signal),
  });

  return (
    <div className="space-y-10">
      <section aria-labelledby="sla-heading">
        <h1 id="sla-heading" className="text-2xl font-semibold text-content">
          SLA policies and calendars
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          A policy sets the response and resolution targets for each priority against a business
          calendar. Records freeze their target instants when they start, so editing a policy here
          never moves an existing deadline — only a clock override with a recorded reason can do
          that.
        </p>
      </section>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <PolicySection
        policies={policies.data?.items ?? []}
        calendars={calendars.data?.items ?? []}
        loading={policies.isPending}
        onError={setError}
        onSaved={() => {
          setError(null);
          void queryClient.invalidateQueries({ queryKey: ['sla', 'policies'] });
        }}
      />

      <CalendarSection
        calendars={calendars.data?.items ?? []}
        loading={calendars.isPending}
        onError={setError}
        onSaved={() => {
          setError(null);
          void queryClient.invalidateQueries({ queryKey: ['sla', 'calendars'] });
          // An edit moves every policy onto the new version, so a policy row showing its
          // old calendar would be stale the moment the save lands.
          void queryClient.invalidateQueries({ queryKey: ['sla', 'policies'] });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

interface PolicySectionProps {
  policies: SlaPolicy[];
  calendars: BusinessCalendar[];
  loading: boolean;
  onError: (message: string) => void;
  onSaved: () => void;
}

function PolicySection({ policies, calendars, loading, onError, onSaved }: PolicySectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [pauseStates, setPauseStates] = useState<string[]>(['APPROVAL_PENDING']);
  const [targets, setTargets] = useState<Record<Priority, TargetDraft>>(defaultTargets);

  const save = useMutation({
    mutationFn: (input: PolicyInput) =>
      editingId ? updatePolicy(editingId, input) : createPolicy(input),
    onSuccess: () => {
      resetForm();
      onSaved();
    },
    onError: (mutationError) => onError(messageFor(mutationError)),
  });

  function resetForm(): void {
    setEditingId(null);
    setName('');
    setCalendarId('');
    setIsDefault(false);
    setPauseStates(['APPROVAL_PENDING']);
    setTargets(defaultTargets());
  }

  function startEdit(policy: SlaPolicy): void {
    setEditingId(policy.id);
    setName(policy.name);
    setCalendarId(policy.calendarId);
    setIsDefault(policy.isDefault);
    setPauseStates(Array.isArray(policy.pauseStates) ? (policy.pauseStates as string[]) : []);
    const next = defaultTargets();
    for (const target of policy.targets) {
      next[target.priority] = {
        responseMinutes: String(target.responseMinutes),
        resolveMinutes: String(target.resolveMinutes),
        warnPercent: String(target.warnPercent),
      };
    }
    setTargets(next);
  }

  /** Every priority needs a positive resolve target, or a record cannot be given an SLA. */
  const targetRows: SlaTargetInput[] | null = PRIORITIES.every((priority) => {
    const resolve = Number(targets[priority].resolveMinutes);
    const response = Number(targets[priority].responseMinutes);
    const warn = Number(targets[priority].warnPercent);
    return (
      Number.isInteger(resolve) &&
      resolve > 0 &&
      Number.isInteger(response) &&
      response > 0 &&
      response <= resolve &&
      Number.isInteger(warn) &&
      warn >= 1 &&
      warn <= 99
    );
  })
    ? PRIORITIES.map((priority) => ({
        priority,
        responseMinutes: Number(targets[priority].responseMinutes),
        resolveMinutes: Number(targets[priority].resolveMinutes),
        warnPercent: Number(targets[priority].warnPercent),
      }))
    : null;

  const canSubmit =
    name.trim().length >= 2 && calendarId !== '' && targetRows !== null && !save.isPending;

  return (
    <section aria-labelledby="policies-heading" className="rounded-lg border border-border p-4">
      <h2 id="policies-heading" className="text-lg font-semibold text-content">
        {editingId ? 'Edit policy' : 'New policy'}
      </h2>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || !targetRows) return;
          save.mutate({
            name: name.trim(),
            calendarId,
            pauseStates,
            isActive: true,
            isDefault,
            targets: targetRows,
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-content">Policy name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="block font-medium text-content">Business calendar</span>
            <select
              value={calendarId}
              onChange={(event) => setCalendarId(event.target.value)}
              disabled={calendars.length === 0}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            >
              <option value="">Select a calendar…</option>
              {calendars
                .filter((calendar) => calendar.isActive)
                .map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name} ({calendar.timeZone})
                  </option>
                ))}
            </select>
          </label>

          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
              className="rounded border-border"
            />
            <span className="text-content">Tenant default</span>
          </label>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-content">Targets (working minutes)</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PRIORITIES.map((priority) => (
              <div key={priority} className="rounded border border-border p-3">
                <p className="text-sm font-medium text-content">{priority}</p>
                <label className="mt-2 block space-y-1 text-xs text-content-muted">
                  <span>Response minutes</span>
                  <input
                    type="number"
                    min={1}
                    aria-label={`${priority} response minutes`}
                    value={targets[priority].responseMinutes}
                    onChange={(event) =>
                      setTargets((current) => ({
                        ...current,
                        [priority]: { ...current[priority], responseMinutes: event.target.value },
                      }))
                    }
                    className="w-full rounded border border-border bg-surface px-2 py-1 text-content"
                  />
                </label>
                <label className="mt-2 block space-y-1 text-xs text-content-muted">
                  <span>Resolve minutes</span>
                  <input
                    type="number"
                    min={1}
                    aria-label={`${priority} resolve minutes`}
                    value={targets[priority].resolveMinutes}
                    onChange={(event) =>
                      setTargets((current) => ({
                        ...current,
                        [priority]: { ...current[priority], resolveMinutes: event.target.value },
                      }))
                    }
                    className="w-full rounded border border-border bg-surface px-2 py-1 text-content"
                  />
                </label>
                <label className="mt-2 block space-y-1 text-xs text-content-muted">
                  <span>Warn at %</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    aria-label={`${priority} warn percent`}
                    value={targets[priority].warnPercent}
                    onChange={(event) =>
                      setTargets((current) => ({
                        ...current,
                        [priority]: { ...current[priority], warnPercent: event.target.value },
                      }))
                    }
                    className="w-full rounded border border-border bg-surface px-2 py-1 text-content"
                  />
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-content">
            Pause the clock in these states
          </legend>
          <div className="flex flex-wrap gap-3">
            {PAUSE_STATES.map((state) => (
              <label key={state} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pauseStates.includes(state)}
                  onChange={(event) =>
                    setPauseStates((current) =>
                      event.target.checked
                        ? [...current, state]
                        : current.filter((value) => value !== state),
                    )
                  }
                  className="rounded border-border"
                />
                <span className="text-content">{state}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-content-muted">
            A state left unchecked keeps the clock running — an approval wait with no pause is a
            deliberate policy choice, not an oversight.
          </p>
        </fieldset>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : editingId ? 'Save policy' : 'Create policy'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded border border-border px-4 py-2 text-content"
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-content">Configured policies</h3>
        {loading && (
          <p role="status" className="mt-2 text-sm text-content-muted">
            Loading policies…
          </p>
        )}
        {!loading && policies.length === 0 && (
          <p className="mt-2 text-sm text-content-muted">No policies configured yet.</p>
        )}
        {policies.length > 0 && (
          <ul className="mt-2 divide-y divide-border rounded border border-border">
            {policies.map((policy) => (
              <li
                key={policy.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-content">{policy.name}</p>
                  <p className="mt-0.5 text-xs text-content-muted">
                    {policy.calendar.name} · {policy.calendar.timeZone} ·{' '}
                    {policy.targets
                      .map((target) => `${target.priority} ${target.resolveMinutes}m`)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {policy.isDefault && <StatusBadge tone="info">DEFAULT</StatusBadge>}
                  <StatusBadge tone={policy.isActive ? 'success' : 'neutral'}>
                    {policy.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </StatusBadge>
                  <button
                    type="button"
                    onClick={() => startEdit(policy)}
                    className="rounded border border-border px-3 py-1 text-sm text-content"
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

interface CalendarSectionProps {
  calendars: BusinessCalendar[];
  loading: boolean;
  onError: (message: string) => void;
  onSaved: () => void;
}

function CalendarSection({ calendars, loading, onError, onSaved }: CalendarSectionProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [timeZone, setTimeZone] = useState('Europe/London');
  const [model, setModel] = useState<'WORKING_HOURS' | 'WALL_CLOCK'>('WORKING_HOURS');
  const [workingHours, setWorkingHours] = useState<Record<string, { start: string; end: string }>>({
    mon: { start: '09:00', end: '17:00' },
    tue: { start: '09:00', end: '17:00' },
    wed: { start: '09:00', end: '17:00' },
    thu: { start: '09:00', end: '17:00' },
    fri: { start: '09:00', end: '17:00' },
  });
  const [holidays, setHolidays] = useState('');

  const save = useMutation({
    mutationFn: (input: CreateCalendarInput) =>
      editingId ? updateCalendar(editingId, input) : createCalendar(input),
    onSuccess: () => {
      resetForm();
      onSaved();
    },
    onError: (mutationError) => onError(messageFor(mutationError)),
  });

  function resetForm(): void {
    setEditingId(null);
    setName('');
    setHolidays('');
  }

  /** Prefills the editor from a calendar's stored version — arrays reduced to one window per day. */
  function startEdit(calendar: BusinessCalendar): void {
    setEditingId(calendar.id);
    setName(calendar.name);
    setTimeZone(calendar.timeZone);
    setModel(calendar.model);
    setWorkingHours(windowsOf(calendar.workingHours));
    setHolidays(Array.isArray(calendar.holidays) ? calendar.holidays.map(String).join(', ') : '');
  }

  const holidayList = holidays
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const holidaysValid = holidayList.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  const days = Object.keys(workingHours);
  const canSubmit =
    name.trim().length >= 2 &&
    holidaysValid &&
    (model === 'WALL_CLOCK' || days.length > 0) &&
    !save.isPending;

  return (
    <section aria-labelledby="calendars-heading" className="rounded-lg border border-border p-4">
      <h2 id="calendars-heading" className="text-lg font-semibold text-content">
        {editingId ? 'Edit business calendar' : 'New business calendar'}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-content-muted">
        An edit is saved as a new version rather than an edit of the row existing records were
        computed against: in-flight records keep the version they started under, and policies move
        to the new version so new records use it.
      </p>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          save.mutate({
            name: name.trim(),
            timeZone: timeZone.trim(),
            model,
            workingHours:
              model === 'WALL_CLOCK'
                ? {}
                : Object.fromEntries(
                    days.map((day) => [
                      day,
                      [
                        {
                          start: workingHours[day]?.start ?? '09:00',
                          end: workingHours[day]?.end ?? '17:00',
                        },
                      ],
                    ]),
                  ),
            holidays: holidayList,
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-content">Calendar name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-content">Time zone (IANA)</span>
            <input
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-content">Model</span>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value as 'WORKING_HOURS' | 'WALL_CLOCK')}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            >
              <option value="WORKING_HOURS">Working hours</option>
              <option value="WALL_CLOCK">24×7 wall clock</option>
            </select>
          </label>
        </div>

        {model === 'WORKING_HOURS' && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-content">Working hours</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {WEEKDAYS.map((day) => {
                const window = workingHours[day.key];
                return (
                  <div key={day.key} className="flex items-center gap-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(window)}
                        onChange={(event) =>
                          setWorkingHours((current) => {
                            const next = { ...current };
                            if (event.target.checked) {
                              next[day.key] = { start: '09:00', end: '17:00' };
                            } else {
                              delete next[day.key];
                            }
                            return next;
                          })
                        }
                        className="rounded border-border"
                      />
                      <span className="w-20 text-content">{day.label}</span>
                    </label>
                    {window && (
                      <>
                        <input
                          aria-label={`${day.label} start`}
                          value={window.start}
                          onChange={(event) =>
                            setWorkingHours((current) => ({
                              ...current,
                              [day.key]: { ...window, start: event.target.value },
                            }))
                          }
                          className="w-20 rounded border border-border bg-surface px-2 py-1 text-content"
                        />
                        <input
                          aria-label={`${day.label} end`}
                          value={window.end}
                          onChange={(event) =>
                            setWorkingHours((current) => ({
                              ...current,
                              [day.key]: { ...window, end: event.target.value },
                            }))
                          }
                          className="w-20 rounded border border-border bg-surface px-2 py-1 text-content"
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}

        <label className="block space-y-1 text-sm">
          <span className="block font-medium text-content">
            Holidays (YYYY-MM-DD, comma separated)
          </span>
          <input
            value={holidays}
            onChange={(event) => setHolidays(event.target.value)}
            placeholder="2026-12-25, 2026-12-26"
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
          {!holidaysValid && (
            <span role="alert" className="block text-xs text-danger">
              Holidays must be ISO dates, for example 2026-12-25.
            </span>
          )}
        </label>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : editingId ? 'Save new version' : 'Create calendar'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded border border-border px-4 py-2 text-content"
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-content">Configured calendars</h3>
        {loading && (
          <p role="status" className="mt-2 text-sm text-content-muted">
            Loading calendars…
          </p>
        )}
        {!loading && calendars.length === 0 && (
          <p className="mt-2 text-sm text-content-muted">No calendars configured yet.</p>
        )}
        {calendars.length > 0 && (
          <ul className="mt-2 divide-y divide-border rounded border border-border">
            {calendars.map((calendar) => (
              <li
                key={calendar.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-content">{calendar.name}</p>
                  <p className="mt-0.5 text-xs text-content-muted">
                    {calendar.timeZone} ·{' '}
                    {calendar.model === 'WALL_CLOCK' ? '24×7' : 'working hours'} ·{' '}
                    {holidayCount(calendar)} holiday(s) · version {calendar.version}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={calendar.isActive ? 'success' : 'neutral'}>
                    {calendar.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </StatusBadge>
                  {calendar.isActive && (
                    <button
                      type="button"
                      onClick={() => startEdit(calendar)}
                      className="rounded border border-border px-3 py-1 text-sm text-content"
                    >
                      Edit calendar
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function holidayCount(calendar: BusinessCalendar): number {
  return Array.isArray(calendar.holidays) ? calendar.holidays.length : 0;
}

/**
 * Reduces a stored calendar's `Record<day, window[]>` to the editor's single window per
 * day. A second window on the same day would be dropped by the form, so the edit starts
 * from the first — and saving then genuinely changes the stored shape, which is visible in
 * the version diff rather than silently assumed.
 */
function windowsOf(value: unknown): Record<string, { start: string; end: string }> {
  const result: Record<string, { start: string; end: string }> = {};
  if (typeof value !== 'object' || value === null) return result;
  for (const [day, windows] of Object.entries(value as Record<string, unknown>)) {
    const first = Array.isArray(windows) ? windows[0] : undefined;
    if (typeof first === 'object' && first !== null && 'start' in first && 'end' in first) {
      result[day] = {
        start: String((first as { start: unknown }).start),
        end: String((first as { end: unknown }).end),
      };
    }
  }
  return result;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.errors.length > 0) {
      return `${error.message} (${error.errors.map((detail) => detail.message).join('; ')})`;
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
