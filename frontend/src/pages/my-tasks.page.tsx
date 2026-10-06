import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { listMyTasks, type TaskStatus, type TaskView } from '../api/tasks.api';
import { StatusBadge } from '../components/status-badge';
import type { Tone } from '../themes/tokens';

/**
 * My tasks (docs/24 §10).
 *
 * Across all parents, grouped by due state. The list is scoped server-side to the
 * caller's assignments; the UI adds no scope of its own.
 */

const STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'];

const STATUS_TONE: Record<TaskStatus, Tone> = {
  TODO: 'neutral',
  IN_PROGRESS: 'info',
  BLOCKED: 'danger',
  DONE: 'success',
  CANCELLED: 'neutral',
};

function bucketFor(task: TaskView): string {
  if (task.status === 'DONE' || task.status === 'CANCELLED') return 'Closed';
  if (!task.dueAt) return 'No due date';
  const due = new Date(task.dueAt);
  const now = new Date();
  if (due.getTime() < now.getTime()) return 'Overdue';
  const today = new Date(now);
  today.setHours(23, 59, 59, 999);
  if (due.getTime() <= today.getTime()) return 'Due today';
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  if (due.getTime() <= week.getTime()) return 'This week';
  return 'Later';
}

const ORDER = ['Overdue', 'Due today', 'This week', 'Later', 'No due date', 'Closed'];

export function MyTasksPage() {
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const tasks = useQuery({
    queryKey: ['tasks', { status }],
    queryFn: ({ signal }) => listMyTasks(status ? { status } : {}, signal),
  });

  const grouped = new Map<string, TaskView[]>();
  for (const task of tasks.data?.items ?? []) {
    const bucket = bucketFor(task);
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), task]);
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="my-tasks-heading">
        <h1 id="my-tasks-heading" className="text-2xl font-semibold text-content">
          My tasks
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          The pieces of work assigned to you across every request and incident.
        </p>
      </section>

      <label className="flex items-center gap-2 text-sm">
        <span className="text-content-muted">Status</span>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskStatus | '')}
          className="rounded border border-border bg-surface px-3 py-1.5 text-content"
        >
          <option value="">All</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      {tasks.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading tasks…
        </p>
      )}
      {tasks.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(tasks.error)}
        </p>
      )}
      {tasks.isSuccess && tasks.data.items.length === 0 && (
        <p className="text-sm text-content-muted">You have no tasks assigned.</p>
      )}

      {ORDER.filter((bucket) => (grouped.get(bucket) ?? []).length > 0).map((bucket) => (
        <section key={bucket} aria-labelledby={`bucket-${bucket}`} className="space-y-2">
          <h2
            id={`bucket-${bucket}`}
            className="text-sm font-semibold uppercase tracking-wide text-content-muted"
          >
            {bucket}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {(grouped.get(bucket) ?? []).map((task) => (
              <li key={task.id}>
                <Link
                  to={`/${task.parentType === 'REQUEST' ? 'requests' : 'incidents'}/${task.parentId}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted"
                >
                  <span>
                    <span className="text-sm font-medium text-content">{task.title}</span>
                    <span className="mt-0.5 block text-xs text-content-muted">
                      {task.parentLabel}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {task.overdue && <StatusBadge tone="danger">Overdue</StatusBadge>}
                    <StatusBadge tone={STATUS_TONE[task.status]}>{task.status}</StatusBadge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
