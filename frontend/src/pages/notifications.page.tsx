import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  listNotifications,
  readAllNotifications,
  readNotification,
} from '../api/notifications.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Notification centre (docs/29 §13).
 *
 * The list, the unread count and every mutation are self-scoped by the server. Marking a
 * notification read is idempotent, so a double click is harmless.
 */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notifications = useQuery({
    queryKey: ['notifications', { unreadOnly }],
    queryFn: ({ signal }) => listNotifications({ unreadOnly, limit: 50 }, signal),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => readNotification(id),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const markAll = useMutation({
    mutationFn: () => readAllNotifications(),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const items = notifications.data?.items ?? [];
  const unreadCount = notifications.data?.unreadCount ?? 0;

  return (
    <div className="space-y-6">
      <section aria-labelledby="notifications-heading">
        <h1 id="notifications-heading" className="text-2xl font-semibold text-content">
          Notifications
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          In-app updates from the work you are part of. Transactional messages such as a password
          reset are never shown here — they are security events, not news.
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

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          <span className="text-content">Unread only</span>
        </label>
        <button
          type="button"
          onClick={() => markAll.mutate()}
          disabled={markAll.isPending || unreadCount === 0}
          className="rounded border border-border px-3 py-1.5 text-sm text-content disabled:opacity-60"
        >
          Mark all read
        </button>
        <Link
          to="/me/notification-preferences"
          className="text-sm text-content-muted hover:text-content"
        >
          Preferences
        </Link>
      </div>

      {notifications.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading notifications…
        </p>
      )}
      {notifications.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(notifications.error)}
        </p>
      )}
      {notifications.isSuccess && items.length === 0 && (
        <p className="text-sm text-content-muted">Nothing to show.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((notification) => (
            <li
              key={notification.id}
              className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-content">
                  {notification.title ?? notification.eventType}
                  {notification.readAt === null && (
                    <StatusBadge tone="info">
                      <span className="ml-2">Unread</span>
                    </StatusBadge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-content-muted">
                  {new Date(notification.createdAt).toLocaleString()}
                </p>
                {notification.linkUrl && (
                  <Link
                    to={notification.linkUrl}
                    className="mt-1 inline-block text-sm text-brand hover:underline"
                  >
                    Open record
                  </Link>
                )}
              </div>
              {notification.readAt === null && (
                <button
                  type="button"
                  onClick={() => markRead.mutate(notification.id)}
                  disabled={markRead.isPending}
                  className="rounded border border-border px-3 py-1 text-sm text-content disabled:opacity-60"
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
