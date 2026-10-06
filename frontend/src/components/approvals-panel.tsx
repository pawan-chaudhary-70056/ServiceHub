import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  decideApproval,
  getRequestApprovals,
  type ApprovalStepStatus,
  type ApprovalWorkflowStatus,
} from '../api/approvals.api';
import { StatusBadge } from './status-badge';
import { useAuth } from '../hooks/auth-context';
import type { Tone } from '../themes/tokens';

/**
 * Approval progress for a request (docs/26 §12).
 *
 * The panel shows the *reason the request exists* alongside the workflow, not the id alone —
 * so a decision is informed rather than a rubber stamp. Steps are shown to any caller
 * allowed to see the request; the decide/reject controls appear only for a caller who is a
 * designated approver on the active step, and the server enforces the same rule
 * independently. Visibility of the workflow itself is A5: a caller who may not see it gets a
 * `404`, which this panel treats as "no workflow to show".
 */

const STEP_TONE: Record<ApprovalStepStatus, Tone> = {
  PENDING: 'neutral',
  ACTIVE: 'info',
  COMPLETED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

const WORKFLOW_TONE: Record<ApprovalWorkflowStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export interface ApprovalsPanelProps {
  requestId: string;
  /** The requester's id, so the panel can suppress self-approval controls (docs/07 §5). */
  requesterId?: string;
}

export function ApprovalsPanel({ requestId, requesterId }: ApprovalsPanelProps) {
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const workflow = useQuery({
    queryKey: ['request', requestId, 'approvals'],
    queryFn: ({ signal }) => getRequestApprovals(requestId, signal),
    // A hidden workflow is a 404 by contract; that is not an error to retry or surface.
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (input: { stepId: string; decision: 'APPROVE' | 'REJECT'; comment?: string }) =>
      decideApproval(input.stepId, { decision: input.decision, comment: input.comment }),
    onSuccess: () => {
      setError(null);
      setRejecting(false);
      setComment('');
      void queryClient.invalidateQueries({ queryKey: ['request', requestId, 'approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['request', requestId] });
      void queryClient.invalidateQueries({ queryKey: ['approvals', 'pending'] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const data = workflow.data?.workflow ?? null;
  if (!data) {
    return null;
  }

  const canDecide = hasPermission('approval:decide');
  const activeStep = data.steps.find((step) => step.status === 'ACTIVE') ?? null;
  const isDesignated = activeStep?.approvers.some((approver) => approver.id === user?.id) ?? false;
  // The server refuses self-approval regardless; hiding the control avoids offering it.
  const isRequester = requesterId !== undefined && requesterId === user?.id;
  const mayDecide = data.status === 'PENDING' && canDecide && isDesignated && !isRequester;

  return (
    <section aria-labelledby="approvals-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="approvals-heading" className="text-lg font-semibold text-content">
          Approval
        </h2>
        <StatusBadge tone={WORKFLOW_TONE[data.status]}>{data.status}</StatusBadge>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <ol className="space-y-2">
        {data.steps.map((step) => (
          <li key={step.id} className="rounded border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-content">
                Step {step.stepOrder}
                <span className="ml-2 text-xs font-normal text-content-muted">
                  {step.mode === 'ALL' ? 'all approvers' : 'any approver'}
                </span>
              </span>
              <StatusBadge tone={STEP_TONE[step.status]}>{step.status}</StatusBadge>
            </div>

            <p className="mt-1 text-xs text-content-muted">
              {step.approvers.map((approver) => approver.displayName).join(', ') || 'No approvers'}
            </p>

            {step.decisions.length > 0 && (
              <ul className="mt-2 space-y-1">
                {step.decisions.map((decision) => (
                  <li key={decision.id} className="text-xs">
                    <span className="font-medium text-content">
                      {decision.approver.displayName}
                    </span>{' '}
                    <span
                      className={
                        decision.outcome === 'REJECT' ? 'text-danger' : 'text-content-muted'
                      }
                    >
                      {decision.outcome === 'REJECT' ? 'rejected' : 'approved'}
                    </span>
                    <span className="text-content-muted">
                      {' '}
                      · {new Date(decision.decidedAt).toLocaleString()}
                    </span>
                    {decision.comment && (
                      <span className="block text-content-muted">{decision.comment}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {mayDecide && step.status === 'ACTIVE' && (
              <div className="mt-3 space-y-2">
                {rejecting ? (
                  <form
                    className="space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (comment.trim()) {
                        decide.mutate({
                          stepId: step.id,
                          decision: 'REJECT',
                          comment: comment.trim(),
                        });
                      }
                    }}
                  >
                    <label className="block text-sm font-medium text-content">
                      Reason for rejection (required — ends the workflow)
                    </label>
                    <textarea
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      rows={2}
                      required
                      className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
                    />
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={decide.isPending || !comment.trim()}
                        className="rounded border border-danger/40 px-3 py-1.5 text-sm text-danger disabled:opacity-60"
                      >
                        Confirm rejection
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRejecting(false);
                          setComment('');
                        }}
                        className="rounded border border-border px-3 py-1.5 text-sm text-content"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        decide.mutate({
                          stepId: step.id,
                          decision: 'APPROVE',
                          comment: comment || undefined,
                        })
                      }
                      disabled={decide.isPending}
                      className="rounded bg-brand px-3 py-1.5 text-sm text-content-inverted disabled:opacity-60"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejecting(true)}
                      className="rounded border border-danger/40 px-3 py-1.5 text-sm text-danger"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
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
