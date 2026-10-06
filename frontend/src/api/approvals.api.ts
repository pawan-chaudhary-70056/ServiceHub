import { apiRequest } from './client';

/**
 * Approval API (docs/26 §11, docs/11 §9).
 *
 * A decision is recorded against a **step**, so `decideApproval` and `reassignApprovalStep`
 * take a step id, not a workflow id. The server is the authority on who may decide: the
 * endpoint requires `approval:decide`, and the service independently checks that the caller
 * is a designated approver for the active step and is not the requester (docs/07 §5). The UI
 * only decides whether to *offer* the control.
 */

export type ApprovalOutcome = 'APPROVE' | 'REJECT';
export type ApprovalMode = 'ANY' | 'ALL';
export type ApprovalStepStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
export type ApprovalWorkflowStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface ApprovalDecisionView {
  id: string;
  outcome: ApprovalOutcome;
  comment: string | null;
  decidedAt: string;
  approver: { id: string; displayName: string };
}

export interface ApprovalStepView {
  id: string;
  stepOrder: number;
  mode: ApprovalMode;
  status: ApprovalStepStatus;
  approvers: Array<{ id: string; displayName: string }>;
  decisions: ApprovalDecisionView[];
}

export interface ApprovalWorkflowView {
  id: string;
  request: { id: string; reference: string; title: string };
  status: ApprovalWorkflowStatus;
  currentStepOrder: number;
  steps: ApprovalStepView[];
  createdAt: string;
  completedAt: string | null;
}

export interface ApprovalTemplateView {
  id: string;
  catalogItemId: string;
  name: string;
  isActive: boolean;
  steps: Array<{ stepOrder: number; mode: ApprovalMode; approverRoleKey: string }>;
}

export interface CreateApprovalTemplateInput {
  catalogItemId: string;
  name: string;
  steps: Array<{ stepOrder: number; mode: ApprovalMode; approverRoleKey: string }>;
}

/** The caller's own pending decisions; the server returns only steps they may act on. */
export function listPendingApprovals(
  signal?: AbortSignal,
): Promise<{ items: ApprovalWorkflowView[] }> {
  return apiRequest<{ items: ApprovalWorkflowView[] }>('/approvals/pending', { signal });
}

/** The workflow for a request, or `null` when the request has none (visibility per A5). */
export function getRequestApprovals(
  requestId: string,
  signal?: AbortSignal,
): Promise<{ workflow: ApprovalWorkflowView | null }> {
  return apiRequest<{ workflow: ApprovalWorkflowView | null }>(`/requests/${requestId}/approvals`, {
    signal,
  });
}

export function decideApproval(
  stepId: string,
  input: { decision: ApprovalOutcome; comment?: string },
): Promise<{ workflow: ApprovalWorkflowView; recorded: boolean }> {
  return apiRequest<{ workflow: ApprovalWorkflowView; recorded: boolean }>(
    `/approvals/${stepId}/decide`,
    { method: 'POST', body: input },
  );
}

export function reassignApprovalStep(
  stepId: string,
  approverIds: string[],
): Promise<{ workflow: ApprovalWorkflowView }> {
  return apiRequest<{ workflow: ApprovalWorkflowView }>(`/approvals/${stepId}/reassign`, {
    method: 'POST',
    body: { approverIds },
  });
}

export function listApprovalTemplates(
  signal?: AbortSignal,
): Promise<{ items: ApprovalTemplateView[] }> {
  return apiRequest<{ items: ApprovalTemplateView[] }>('/admin/approval-templates', { signal });
}

export function createApprovalTemplate(
  input: CreateApprovalTemplateInput,
): Promise<{ template: ApprovalTemplateView }> {
  return apiRequest<{ template: ApprovalTemplateView }>('/admin/approval-templates', {
    method: 'POST',
    body: input,
  });
}
