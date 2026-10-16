import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { overrideClock, type SlaClock } from '../api/sla.api';

/**
 * SLA clock override (`docs/25` §11, §14 AC8).
 *
 * An override is the **only** way a deadline moves by hand, and the reason is mandatory: the
 * target instants are otherwise frozen so that a policy edit cannot rewrite history, which
 * means a change here is a deliberate, recorded act rather than a side effect. The form
 * therefore asks for the reason first and refuses to submit without one — the server rejects
 * it too, and the audit entry stores it.
 *
 * Rendered only for a caller the server would accept (the permission check here is a
 * convenience; `sla:clock:override` is enforced again on the endpoint).
 */
export function SlaOverrideForm({
  clock,
  onOverridden,
}: {
  clock: SlaClock;
  onOverridden?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState('');
  const [clearBreach, setClearBreach] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const override = useMutation({
    mutationFn: () =>
      overrideClock(clock.id, {
        reason: reason.trim(),
        ...(target ? { targetAt: new Date(target).toISOString() } : {}),
        ...(clearBreach ? { clearBreach: true } : {}),
      }),
    onSuccess: () => {
      setError(null);
      setDone(true);
      setReason('');
      setTarget('');
      setClearBreach(false);
      onOverridden?.();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const nothingRequested = target === '' && !clearBreach;
  const canSubmit = reason.trim().length >= 5 && !nothingRequested && !override.isPending;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-border px-3 py-1.5 text-sm text-content"
      >
        Override SLA
      </button>
    );
  }

  return (
    <form
      className="space-y-3 rounded border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) override.mutate();
      }}
    >
      <p className="text-sm font-medium text-content">Override this SLA clock</p>
      <p className="text-xs text-content-muted">
        The target is frozen so that policy edits cannot move it. Moving it here is a recorded act:
        the reason is kept with the before and after instants.
      </p>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {done && !error && (
        <p role="status" className="text-sm text-success">
          Override recorded.
        </p>
      )}

      <label className="block space-y-1 text-sm">
        <span className="block font-medium text-content">New target (optional)</span>
        <input
          type="datetime-local"
          aria-label="New target (optional)"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
        />
        <span className="block text-xs text-content-muted">
          Current target: {new Date(clock.targetAt).toLocaleString()}
        </span>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={clearBreach}
          onChange={(event) => setClearBreach(event.target.checked)}
          className="rounded border-border"
        />
        <span className="text-content">Clear the recorded breach</span>
      </label>

      <label className="block space-y-1 text-sm">
        <span className="block font-medium text-content">Reason (required)</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-brand px-3 py-1.5 text-sm text-content-inverted disabled:opacity-60"
        >
          {override.isPending ? 'Recording…' : 'Record override'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-border px-3 py-1.5 text-sm text-content"
        >
          Cancel
        </button>
      </div>
      {nothingRequested && (
        <p className="text-xs text-content-muted">
          Ask for a new target, remove the breach, or both — an override that changes nothing is
          refused.
        </p>
      )}
    </form>
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
