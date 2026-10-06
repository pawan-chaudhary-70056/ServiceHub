import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  decideApproval,
  listPendingApprovals,
  type ApprovalOutcome,
  type ApprovalWorkflowView,
} from '../api/approvals.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Approvals inbox (docs/26 §12).
 *
 * The caller's pending decisions only — the server returns just the steps they are a
 * designated approver for, so the inbox cannot become a back door to another team's queue
 * (rule A5). Each row shows the request's reference and title, not its id, because an
 * approver deciding from an id alone is not making a decision; the full context is one
 * click away on the request.
 */

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const pending = useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: ({ signal }) => listPendingApprovals(signal),
  });

  const decide = useMutation({
    mutationFn: (input: { stepId: string; decision: ApprovalOutcome; comment?: string }) =>
      decideApproval(input.stepId, { decision: input.decision, comment: input.comment }),
    onSuccess: () => {
      setError(null);
      setRejectingId(null);
      setComment('');
      void queryClient.invalidateQueries({ queryKey: ['approvals', 'pending'] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const items = pending.data?.items ?? [];

  return (
    <div className="space-y-6">
      <section aria-labelledby="approvals-heading">
        <h1 id="approvals-heading" className="text-2xl font-semibold text-content">
          Approvals
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Requests waiting on your decision. Approving does not grant you any fulfilment permission
          — it records a decision.
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

      {pending.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading approvals…
        </p>
      )}
      {pending.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(pending.error)}
        </p>
      )}
      {pending.isSuccess && items.length === 0 && (
        <p className="text-sm text-content-muted">You have no approvals waiting.</p>
      )}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((workflow) => (
            <li key={workflow.id}>
              <ApprovalCard
                workflow={workflow}
                rejecting={rejectingId === workflow.id}
                comment={comment}
                onChangeComment={setComment}
                onStartReject={() => {
                  setRejectingId(rejectingId === workflow.id ? null : workflow.id);
                  setComment('');
                }}
                onCancelReject={() => {
                  setRejectingId(null);
                  setComment('');
                }}
                onDecide={(stepId, decision, body) =>
                  decide.mutate({ stepId, decision, comment: body })
                }
                busy={decide.isPending}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalCard({
  workflow,
  rejecting,
  comment,
  onChangeComment,
  onStartReject,
  onCancelReject,
  onDecide,
  busy,
}: {
  workflow: ApprovalWorkflowView;
  rejecting: boolean;
  comment: string;
  onChangeComment: (value: string) => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onDecide: (stepId: string, decision: ApprovalOutcome, comment?: string) => void;
  busy: boolean;
}) {
  const activeStep = workflow.steps.find((step) => step.status === 'ACTIVE') ?? null;
  const approvedCount = activeStep?.decisions.filter((d) => d.outcome === 'APPROVE').length ?? 0;

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-content-muted">{workflow.request.reference}</p>
          <Link
            to={`/requests/${workflow.request.id}`}
            className="text-sm font-medium text-content hover:underline"
          >
            {workflow.request.title}
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone="warning">Step {workflow.currentStepOrder}</StatusBadge>
          {activeStep && (
            <StatusBadge tone="neutral">{activeStep.mode === 'ALL' ? 'ALL' : 'ANY'}</StatusBadge>
          )}
        </div>
      </div>

      {activeStep && (
        <p className="mt-2 text-xs text-content-muted">
          {approvedCount} of {activeStep.approvers.length} approved so far
        </p>
      )}

      {activeStep && rejecting && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim()) onDecide(activeStep.id, 'REJECT', comment.trim());
          }}
        >
          <label className="block text-sm font-medium text-content">
            Reason for rejection (required — ends the workflow)
          </label>
          <textarea
            aria-label="Reason for rejection"
            value={comment}
            onChange={(event) => onChangeComment(event.target.value)}
            rows={2}
            required
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !comment.trim()}
              className="rounded border border-danger/40 px-3 py-1.5 text-sm text-danger disabled:opacity-60"
            >
              Confirm rejection
            </button>
            <button
              type="button"
              onClick={onCancelReject}
              className="rounded border border-border px-3 py-1.5 text-sm text-content"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {activeStep && !rejecting && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onDecide(activeStep.id, 'APPROVE')}
            disabled={busy}
            className="rounded bg-brand px-3 py-1.5 text-sm text-content-inverted disabled:opacity-60"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={onStartReject}
            className="rounded border border-danger/40 px-3 py-1.5 text-sm text-danger"
          >
            Reject
          </button>
        </div>
      )}
    </div>
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
