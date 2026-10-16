import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCalendar,
  createPolicy,
  listCalendars,
  listPolicies,
  updateCalendar,
} from '../api/sla.api';
import { SlaPage } from './sla.page';

/**
 * SLA administration tests (`docs/25` §12).
 *
 * Two behaviours are worth pinning, both from the document:
 *
 *   - the **target matrix is the policy**, so the form must send all four priorities with the
 *     values the administrator typed — a partial matrix is a record that cannot be given an
 *     SLA;
 *   - a **holiday list is validated in the form**, because an unparseable date reaching the
 *     calendar would silently contribute working time that should have been closed;
 *   - a **calendar edit saves a new version** (`docs/25` §4 rule 6): the PATCH carries the
 *     calendar's id and the full effective definition, because the server writes it to a
 *     new row rather than mutating the one in-flight records were computed against.
 */

vi.mock('../api/sla.api', () => ({
  listPolicies: vi.fn(),
  listCalendars: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  createCalendar: vi.fn(),
  updateCalendar: vi.fn(),
}));

const CALENDAR_ID = 'cal-1';

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SlaPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPolicies).mockResolvedValue({
    items: [
      {
        id: 'policy-1',
        name: 'Default',
        calendarId: CALENDAR_ID,
        pauseStates: ['APPROVAL_PENDING'],
        isActive: true,
        isDefault: true,
        targets: [
          {
            id: 't1',
            priority: 'LOW',
            responseMinutes: 480,
            resolveMinutes: 2880,
            warnPercent: 75,
          },
          {
            id: 't2',
            priority: 'MEDIUM',
            responseMinutes: 240,
            resolveMinutes: 1440,
            warnPercent: 75,
          },
          {
            id: 't3',
            priority: 'HIGH',
            responseMinutes: 120,
            resolveMinutes: 480,
            warnPercent: 75,
          },
          {
            id: 't4',
            priority: 'CRITICAL',
            responseMinutes: 60,
            resolveMinutes: 240,
            warnPercent: 75,
          },
        ],
        calendar: {
          id: CALENDAR_ID,
          name: 'Default business hours',
          timeZone: 'Europe/London',
          model: 'WORKING_HOURS',
          workingHours: {},
          holidays: [],
          version: 1,
          isActive: true,
        },
      },
    ],
  } as never);
  vi.mocked(listCalendars).mockResolvedValue({
    items: [
      {
        id: CALENDAR_ID,
        name: 'Default business hours',
        timeZone: 'Europe/London',
        model: 'WORKING_HOURS',
        workingHours: {},
        holidays: ['2026-12-25'],
        version: 1,
        isActive: true,
      },
    ],
  } as never);
  vi.mocked(createPolicy).mockResolvedValue({ policy: {} } as never);
  vi.mocked(createCalendar).mockResolvedValue({ calendar: {} } as never);
});

describe('SlaPage', () => {
  it('lists the configured policies with their target matrix and calendar', async () => {
    renderPage();

    expect(await screen.findByText('Default')).toBeInTheDocument();
    expect(screen.getByText('Configured policies')).toBeInTheDocument();
    expect(screen.getByText('DEFAULT')).toBeInTheDocument();
    expect(screen.getByText(/HIGH 480m/)).toBeInTheDocument();
    // The time zone appears on both the policy row and the calendar row, which is the point:
    // either alone would leave an administrator guessing which calendar a policy resolves
    // its targets against.
    expect(screen.getAllByText(/Europe\/London/).length).toBeGreaterThan(1);
    expect(screen.getByText(/version 1/)).toBeInTheDocument();
  });

  it('creates a policy with every priority target the administrator typed', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Policy name'), 'Hardware policy');
    await user.selectOptions(screen.getByLabelText('Business calendar'), CALENDAR_ID);

    // Change one cell of the matrix, so the test proves the typed value is what is sent
    // rather than the default.
    const criticalResolve = screen.getByLabelText('CRITICAL resolve minutes');
    await user.clear(criticalResolve);
    await user.type(criticalResolve, '120');
    await user.click(screen.getByRole('button', { name: 'Create policy' }));

    await waitFor(() =>
      expect(createPolicy).toHaveBeenCalledWith({
        name: 'Hardware policy',
        calendarId: CALENDAR_ID,
        pauseStates: ['APPROVAL_PENDING'],
        isActive: true,
        isDefault: false,
        targets: [
          { priority: 'LOW', responseMinutes: 480, resolveMinutes: 2880, warnPercent: 75 },
          { priority: 'MEDIUM', responseMinutes: 240, resolveMinutes: 1440, warnPercent: 75 },
          { priority: 'HIGH', responseMinutes: 120, resolveMinutes: 480, warnPercent: 75 },
          { priority: 'CRITICAL', responseMinutes: 60, resolveMinutes: 120, warnPercent: 75 },
        ],
      }),
    );
  });

  it('will not submit a policy with no calendar or no name', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Policy name'), 'Hardware policy');

    // No calendar selected yet, so the policy could not resolve a target instant.
    expect(screen.getByRole('button', { name: 'Create policy' })).toBeDisabled();
    expect(createPolicy).not.toHaveBeenCalled();
  });

  it('refuses a holiday that is not an ISO date', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Calendar name'), 'Support hours');
    await user.type(screen.getByLabelText(/Holidays/), '25/12/2026');

    expect(await screen.findByRole('alert')).toHaveTextContent('Holidays must be ISO dates');
    expect(screen.getByRole('button', { name: 'Create calendar' })).toBeDisabled();
    expect(createCalendar).not.toHaveBeenCalled();
  });

  it('sends working windows and holidays when they are valid', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Calendar name'), 'Support hours');
    await user.type(screen.getByLabelText(/Holidays/), '2026-12-25');
    await user.click(screen.getByRole('button', { name: 'Create calendar' }));

    await waitFor(() =>
      expect(createCalendar).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Support hours',
          timeZone: 'Europe/London',
          model: 'WORKING_HOURS',
          holidays: ['2026-12-25'],
          workingHours: expect.objectContaining({
            mon: [{ start: '09:00', end: '17:00' }],
          }),
        }),
      ),
    );
  });

  it('edits an active calendar by saving a new version of it (25 §4 rule 6)', async () => {
    const user = userEvent.setup();
    vi.mocked(updateCalendar).mockResolvedValue({
      calendar: { id: 'cal-1-v2', version: 2 } as never,
    } as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit calendar' }));

    // The editor opens prefilled from the stored version.
    expect(screen.getByLabelText('Calendar name')).toHaveValue('Default business hours');
    expect(screen.getByLabelText('Time zone (IANA)')).toHaveValue('Europe/London');
    expect(screen.getByLabelText(/Holidays/)).toHaveValue('2026-12-25');

    // A WORKING_HOURS calendar with no checked day has no working time at all, so the save
    // stays disabled until Monday is ticked — proving the hours round-trip into the version.
    const submit = screen.getByRole('button', { name: 'Save new version' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('Monday'));
    expect(submit).toBeEnabled();

    const zone = screen.getByLabelText('Time zone (IANA)');
    await user.clear(zone);
    await user.type(zone, 'Europe/Paris');
    await user.click(submit);

    await waitFor(() =>
      expect(updateCalendar).toHaveBeenCalledWith(
        CALENDAR_ID,
        expect.objectContaining({
          name: 'Default business hours',
          timeZone: 'Europe/Paris',
          model: 'WORKING_HOURS',
          holidays: ['2026-12-25'],
          workingHours: expect.objectContaining({
            mon: [{ start: '09:00', end: '17:00' }],
          }),
        }),
      ),
    );
    expect(createCalendar).not.toHaveBeenCalled();
  });

  it('does not offer an edit for a superseded calendar version', async () => {
    vi.mocked(listCalendars).mockResolvedValue({
      items: [
        {
          id: 'cal-1',
          name: 'Default business hours',
          timeZone: 'Europe/London',
          model: 'WORKING_HOURS',
          workingHours: {},
          holidays: [],
          version: 1,
          isActive: false,
        },
        {
          id: 'cal-1-v2',
          name: 'Default business hours',
          timeZone: 'Europe/London',
          model: 'WORKING_HOURS',
          workingHours: {},
          holidays: [],
          version: 2,
          isActive: true,
        },
      ],
    } as never);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Edit calendar' })).toBeInTheDocument();
    // Exactly one editor entry point: version 1 is history and the server would refuse it.
    expect(screen.getAllByRole('button', { name: 'Edit calendar' })).toHaveLength(1);
  });
});
