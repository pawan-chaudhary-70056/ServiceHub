import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { listSessions, revokeSession, type SessionView } from '../api/auth.api';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';

/**
 * Account security (docs/06 §7, docs/16).
 *
 * The session list exists because revocation that a user cannot reach is a control in
 * name only: the server has always supported immediate revocation, and this is the
 * surface that lets someone act on "I signed in on a machine I no longer have".
 *
 * Two things are stated plainly rather than styled away: the current session is labelled
 * (so nobody revokes the wrong row by accident), and signing out the current device is
 * allowed but ends this page's own session. The UI never claims more than the API
 * guarantees — the server re-authorises and revokes, the page only asks.
 */
export function SecurityPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: ({ signal }) => listSessions(signal),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const items = sessions.data?.items ?? [];

  return (
    <div className="space-y-8">
      <section aria-labelledby="security-heading" className="space-y-2">
        <h1 id="security-heading" className="text-2xl font-semibold text-content">
          Account security
        </h1>
        <p className="max-w-3xl text-sm text-content-muted">
          Sessions are server-side: signing one out ends it immediately, wherever it is, and a
          revoked session cannot be replayed even if its cookie survives on a device.
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

      <section aria-labelledby="identity-heading" className="rounded-lg border border-border p-4">
        <h2 id="identity-heading" className="text-lg font-semibold text-content">
          Identity
        </h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-muted">Name</dt>
            <dd className="text-sm text-content">{user?.displayName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-content-muted">
              Email
            </dt>
            <dd className="text-sm text-content">{user?.email ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="sessions-heading" className="space-y-3">
        <h2 id="sessions-heading" className="text-lg font-semibold text-content">
          Where you are signed in
        </h2>

        {sessions.isPending && (
          <p role="status" className="text-sm text-content-muted">
            Loading your sessions…
          </p>
        )}
        {sessions.isError && (
          <p role="alert" className="text-sm text-danger">
            {messageFor(sessions.error)}
          </p>
        )}
        {sessions.isSuccess && items.length === 0 && (
          <p className="text-sm text-content-muted">No active sessions.</p>
        )}

        {items.length > 0 && (
          <ul className="divide-y divide-border rounded border border-border">
            {items.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm text-content">{describeDevice(session)}</span>
                    {session.current && <StatusBadge tone="info">This device</StatusBadge>}
                  </span>
                  <span className="text-xs text-content-muted">
                    Last active {new Date(session.lastSeenAt).toLocaleString()} · signed in{' '}
                    {new Date(session.createdAt).toLocaleString()} · expires{' '}
                    {new Date(session.absoluteExpiresAt).toLocaleString()}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => revoke.mutate(session.id)}
                  disabled={revoke.isPending}
                  className="rounded border border-border px-3 py-1 text-xs text-content disabled:opacity-60"
                >
                  {session.current ? 'Sign out this device' : 'Sign out'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A short, non-identifying label for the row: agent first, then address. */
function describeDevice(session: SessionView): string {
  const agent = session.userAgent?.split(' ').slice(0, 3).join(' ');
  if (agent && session.sourceIp) return `${agent} · ${session.sourceIp}`;
  return agent ?? session.sourceIp ?? 'Unknown device';
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
