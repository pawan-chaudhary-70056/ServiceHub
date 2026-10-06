import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  assignTask as assignTaskApi,
  createTask as createTaskApi,
  listParentTasks,
  transitionTask,
  type TaskParentType,
  type TaskStatus,
  type TaskView,
} from '../api/tasks.api';
import { StatusBadge } from './status-badge';
import { useAuth } from '../hooks/auth-context';
import type { Tone } from '../themes/tokens';

/**
 * Task checklist for a parent (docs/24 §10).
 *
 * The roll-up indicator ("N of M complete") is the point of this panel: it turns a parent
 * that is silently `IN_PROGRESS` into visible, assigned pieces of work. Actions are
 * offered from the caller's permissions; the server enforces the state machine and the
 * parent roll-up independently.
 */

const STATUS_TONE: Record<TaskStatus, Tone> = {
  TODO: 'neutral',
  IN_PROGRESS: 'info',
  BLOCKED: 'danger',
  DONE: 'success',
  CANCELLED: 'neutral',
};

export interface TasksPanelProps {
  parentType: TaskParentType;
  parentId: string;
  canCreate: boolean;
}

export function TasksPanel({ parentType, parentId, canCreate }: TasksPanelProps) {
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [blockingId, setBlockingId] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tasks = useQuery({
    queryKey: ['tasks', parentType, parentId],
    queryFn: ({ signal }) => listParentTasks(parentType, parentId, signal),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['tasks', parentType, parentId] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };

  const fail = (mutationError: unknown): void => setError(messageFor(mutationError));

  const create = useMutation({
    mutationFn: () => createTaskApi(parentType, parentId, { title }),
    onSuccess: () => {
      setError(null);
      setTitle('');
      refresh();
    },
    onError: fail,
  });

  const assign = useMutation({
    mutationFn: (taskId: string) => assignTaskApi(taskId, user?.id ?? null),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: fail,
  });

  const transition = useMutation({
    mutationFn: (input: { id: string; to: TaskStatus; blockedReason?: string; reason?: string }) =>
      transitionTask(input.id, input),
    onSuccess: () => {
      setError(null);
      setBlockingId(null);
      setBlockReason('');
      refresh();
    },
    onError: fail,
  });

  const canWork =
    hasPermission('task:update.any') ||
    hasPermission('task:update.team') ||
    hasPermission('task:update.own');
  const canCancel = hasPermission('task:cancel');

  const items = tasks.data?.items ?? [];
  const done = items.filter((t) => t.status === 'DONE' || t.status === 'CANCELLED').length;
  const blocked = items.filter((t) => t.status === 'BLOCKED').length;

  return (
    <section aria-labelledby="tasks-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="tasks-heading" className="text-lg font-semibold text-content">
          Tasks
        </h2>
        {items.length > 0 && (
          <p className="text-sm text-content-muted">
            {done} of {items.length} complete
            {blocked > 0 && (
              <StatusBadge tone="danger">
                <span className="ml-2">{blocked} blocked</span>
              </StatusBadge>
            )}
          </p>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {tasks.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading tasks…
        </p>
      )}
      {tasks.isSuccess && items.length === 0 && (
        <p className="text-sm text-content-muted">No tasks yet.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-border rounded border border-border">
          {items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              canWork={canWork}
              canCancel={canCancel}
              isBlocking={blockingId === task.id}
              blockReason={blockReason}
              onChangeBlockReason={setBlockReason}
              onToggleBlock={() => {
                setBlockingId(blockingId === task.id ? null : task.id);
                setBlockReason('');
              }}
              onAssign={() => assign.mutate(task.id)}
              onTransition={(to, extra) => transition.mutate({ id: task.id, to, ...extra })}
            />
          ))}
        </ul>
      )}

      {canCreate && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <label className="min-w-64 flex-1 space-y-1 text-sm">
            <span className="block font-medium text-content">Add a task</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
          </label>
          <button
            type="submit"
            disabled={create.isPending || !title.trim()}
            className="rounded bg-brand px-4 py-2 text-sm text-content-inverted disabled:opacity-60"
          >
            Add task
          </button>
        </form>
      )}
    </section>
  );
}

function TaskRow({
  task,
  canWork,
  canCancel,
  isBlocking,
  blockReason,
  onChangeBlockReason,
  onToggleBlock,
  onAssign,
  onTransition,
}: {
  task: TaskView;
  canWork: boolean;
  canCancel: boolean;
  isBlocking: boolean;
  blockReason: string;
  onChangeBlockReason: (value: string) => void;
  onToggleBlock: () => void;
  onAssign: () => void;
  onTransition: (to: TaskStatus, extra?: { blockedReason?: string; reason?: string }) => void;
}) {
  const terminal = task.status === 'DONE' || task.status === 'CANCELLED';

  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="text-sm font-medium text-content">{task.title}</span>
          <span className="ml-2 text-xs text-content-muted">
            {task.assignee ? task.assignee.displayName : 'Unassigned'}
            {task.dueAt ? ` · due ${new Date(task.dueAt).toLocaleDateString()}` : ''}
          </span>
          {task.overdue && (
            <StatusBadge tone="danger">
              <span className="ml-2">Overdue</span>
            </StatusBadge>
          )}
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge tone={STATUS_TONE[task.status]}>{task.status}</StatusBadge>

          {canWork && !terminal && !task.assignee && (
            <RowButton label="Assign to me" onClick={onAssign} />
          )}
          {canWork && task.status === 'TODO' && task.assignee && (
            <RowButton label="Start" onClick={() => onTransition('IN_PROGRESS')} />
          )}
          {canWork && task.status === 'IN_PROGRESS' && (
            <>
              <RowButton label="Block" onClick={onToggleBlock} />
              <RowButton label="Done" onClick={() => onTransition('DONE')} />
            </>
          )}
          {canWork && task.status === 'BLOCKED' && (
            <RowButton label="Unblock" onClick={() => onTransition('IN_PROGRESS')} />
          )}
          {canCancel && !terminal && (
            <RowButton
              label="Cancel"
              variant="danger"
              onClick={() => onTransition('CANCELLED', { reason: 'Cancelled from the task list' })}
            />
          )}
        </span>
      </div>

      {task.blockedReason && <p className="text-xs text-danger">Blocked: {task.blockedReason}</p>}

      {isBlocking && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (blockReason.trim()) onTransition('BLOCKED', { blockedReason: blockReason.trim() });
          }}
        >
          <input
            value={blockReason}
            onChange={(event) => onChangeBlockReason(event.target.value)}
            placeholder="Why is this blocked? (required)"
            className="min-w-64 flex-1 rounded border border-border bg-surface px-3 py-1.5 text-sm text-content"
          />
          <RowButton label="Confirm block" submit />
        </form>
      )}
    </li>
  );
}

function RowButton({
  label,
  onClick,
  variant = 'primary',
  submit = false,
}: {
  label: string;
  onClick?: () => void;
  variant?: 'primary' | 'danger';
  submit?: boolean;
}) {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      onClick={onClick}
      className={
        variant === 'danger'
          ? 'rounded border border-danger/40 px-2 py-1 text-xs text-danger'
          : 'rounded border border-border px-2 py-1 text-xs text-content'
      }
    >
      {label}
    </button>
  );
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
