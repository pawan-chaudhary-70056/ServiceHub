import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { NotificationPreferencesPage } from './notification-preferences.page';

/**
 * Notification preferences page tests (docs/37 §2, docs/29 §7). The behaviour under test is
 * that a transactional event is fixed on (no toggle that the server would refuse), while an
 * operational event can be turned off.
 */

const updatePreferences = vi.fn().mockResolvedValue({ items: [] });

vi.mock('../api/notifications.api', async () => {
  const actual = await vi.importActual<typeof import('../api/notifications.api')>(
    '../api/notifications.api',
  );
  return {
    ...actual,
    listPreferences: async () => ({
      items: [
        {
          eventType: 'notification.password.reset',
          class: 'TRANSACTIONAL' as const,
          channel: 'EMAIL' as const,
          enabled: true,
          mandatory: true,
        },
        {
          eventType: 'notification.request.assigned',
          class: 'OPERATIONAL' as const,
          channel: 'IN_APP' as const,
          enabled: true,
          mandatory: false,
        },
      ],
    }),
    updatePreferences: (...args: unknown[]) => updatePreferences(...args),
  };
});

function renderPrefs() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationPreferencesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NotificationPreferencesPage', () => {
  it('fixes a transactional event on and allows an operational event to change', async () => {
    const user = userEvent.setup();
    renderPrefs();

    const checkboxes = await screen.findAllByRole('checkbox');
    const mandatoryBox = checkboxes.find((box) => (box as HTMLInputElement).disabled) as
      HTMLInputElement | undefined;
    expect(mandatoryBox).toBeDefined();

    const enabledBox = checkboxes.find(
      (box) => !(box as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    await user.click(enabledBox);

    expect(updatePreferences).toHaveBeenCalledWith([
      { eventType: 'notification.request.assigned', channel: 'IN_APP', enabled: false },
    ]);
  });
});
