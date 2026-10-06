import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  listPreferences,
  updatePreferences,
  type NotificationChannel,
  type PreferenceView,
} from '../api/notifications.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Notification preferences (docs/29 §7, §13).
 *
 * Per event and per channel. A TRANSACTIONAL event is shown, explained, and fixed on —
 * the UI does not offer a toggle that the server will refuse, because a control that
 * silently fails to work is worse than none.
 */

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  EMAIL: 'Email',
  IN_APP: 'In-app',
  SMS: 'SMS',
};

const CLASS_LABEL: Record<string, string> = {
  TRANSACTIONAL: 'Transactional',
  OPERATIONAL: 'Operational',
  INFORMATIONAL: 'Informational',
};

export function NotificationPreferencesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const preferences = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: ({ signal }) => listPreferences(signal),
  });

  const update = useMutation({
    mutationFn: (input: { eventType: string; channel: NotificationChannel; enabled: boolean }) =>
      updatePreferences([input]),
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(['notification-preferences'], data);
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const grouped = new Map<string, PreferenceView[]>();
  for (const item of preferences.data?.items ?? []) {
    grouped.set(item.eventType, [...(grouped.get(item.eventType) ?? []), item]);
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="prefs-heading">
        <h1 id="prefs-heading" className="text-2xl font-semibold text-content">
          Notification preferences
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Choose how you are told about each event. Transactional messages — a password reset, an
          approval waiting on you — cannot be turned off, because they are the only warning of a
          security or correctness event.
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

      {preferences.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading preferences…
        </p>
      )}

      {preferences.isSuccess && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {[...grouped.entries()].map(([eventType, channels]) => {
            const mandatory = channels[0]?.mandatory ?? false;
            return (
              <li
                key={eventType}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <p className="font-mono text-xs text-content-muted">{eventType}</p>
                  <p className="mt-0.5 text-sm text-content">
                    <StatusBadge tone={mandatory ? 'warning' : 'neutral'}>
                      {CLASS_LABEL[channels[0]?.class ?? 'OPERATIONAL']}
                    </StatusBadge>
                    {mandatory && (
                      <span className="ml-2 text-xs text-content-muted">
                        Always on — cannot be disabled
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  {channels.map((preference) => (
                    <label key={preference.channel} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={preference.enabled}
                        disabled={preference.mandatory || update.isPending}
                        onChange={(event) =>
                          update.mutate({
                            eventType: preference.eventType,
                            channel: preference.channel,
                            enabled: event.target.checked,
                          })
                        }
                      />
                      <span className="text-content-muted">
                        {CHANNEL_LABEL[preference.channel]}
                      </span>
                    </label>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
