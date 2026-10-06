import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listNotifications } from '../api/notifications.api';
import { useAuth } from '../hooks/auth-context';

/**
 * Notification bell (docs/29 §13).
 *
 * The unread count is a small, cached read that polls slowly; it is a hint, not a control.
 * The count comes from the server, which scopes it to the caller.
 */
export function NotificationBell() {
  const { isAuthenticated } = useAuth();

  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: ({ signal }) => listNotifications({ unreadOnly: true, limit: 1 }, signal),
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  });

  if (!isAuthenticated) {
    return null;
  }

  const count = unread.data?.unreadCount ?? 0;

  return (
    <Link
      to="/notifications"
      className="text-content-muted hover:text-content"
      aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
    >
      Notifications
      {count > 0 && (
        <span className="ml-1 rounded-full bg-brand px-1.5 py-0.5 text-xs text-content-inverted">
          {count}
        </span>
      )}
    </Link>
  );
}
