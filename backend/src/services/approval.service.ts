import {
  assertAnyPermission,
  assertPermission,
  hasPermission,
  type Principal,
} from '../helpers/authorization';
import {
  ConflictError,
  ForbiddenError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import {
  activateStep,
  cancelRemainingSteps,
  claimStepForCompletion,
  completeWorkflow,
  countStepDecisions,
  createApprovalDecision,
  createApprovalTemplate,
  createApprovalWorkflow,
  findDecisionByApproverForStep,
  findTemplateForCatalogItem,
  findWorkflowById,
  findWorkflowByRequestId,
  findWorkflowForStep,
  listActiveStepsForApprover,
  listActiveUserIdsWithRoleKey,
  listApprovalTemplates,
  replaceStepApprovers,
  runInTransaction,
  setWorkflowCurrentStep,
  updateServiceRequest,
  writeAudit,
  writeOutboxEvent,
  type ApprovalWorkflowWithRelations,
  type DecisionWithApprover,
  type TemplateStepInput,
  type TxClient,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import type { RequestMeta } from './context';
import { resumeClock } from './sla-clock.service';

/**
 * Approvals — docs/26, F-09.
 *
 * An approval is an **auditable decision**, not a notification or a comment (§1). Four
 * properties drive this module:
 *
 *   - **One workflow per record** (A1), by the unique `requestId`.
 *   - **Approvers are snapshotted** at instantiation (A2). Resolving them lazily at
 *     decision time would let a role change mid-workflow rewrite who was asked — the
 *     decision would stop being auditable.
 *   - **Decisions are insert-only** (A3). There is no update or delete path here, and the
 *     database rejects both.
 *   - **Rejection terminates the workflow** (§7) and returns the request to its
 *     requester; a rejection requires a comment (A4).
 *
 * This module never imports `request.service` (that would be a cycle): it changes the
 * request's status through the data layer and resumes the clock itself, so `request` may
 * depend on `approval` without `approval` depending back.
 */

// ===========================================================================
// Instantiation (called by request.service on entry to APPROVAL_PENDING)
// ===========================================================================

/**
 * Instantiates the workflow for a request from its catalog item's template (`docs/26`
 * §4). Runs inside the caller's transaction so the request can never reach
 * `APPROVAL_PENDING` without a workflow.
 *
 * A missing or approverless template is a **configuration defect**, surfaced as a `409`
 * rather than an unapprovable request (`docs/26` §13).
 */
export async function instantiateWorkflowForRequest(
  input: {
    organizationId: string;
    requestId: string;
    catalogItemId: string;
    requesterId: string;
  },
  tx: TxClient,
  meta: RequestMeta,
): Promise<void> {
  const existing = await findWorkflowByRequestId(input.requestId, tx);
  if (existing) {
    return;
  }

  const template = await findTemplateForCatalogItem(input.catalogItemId, tx);
  if (!template || !template.isActive || template.steps.length === 0) {
    throw new ConflictError(
      'This service requires approval but has no active approval template configured.',
    );
  }

  const steps = [];
  for (const step of template.steps) {
    const holders = await listActiveUserIdsWithRoleKey(
      input.organizationId,
      step.approverRoleKey,
      tx,
    );
    // Self-approval is impossible (docs/07 §5): the requester is excluded from the
    // snapshot even when they hold the role.
    const approvers = holders.filter((userId) => userId !== input.requesterId);
    if (approvers.length === 0) {
      throw new ConflictError(
        `Approval step ${step.stepOrder} has no eligible approver; the workflow cannot be instantiated.`,
      );
    }
    steps.push({ stepOrder: step.stepOrder, mode: step.mode, approverIds: approvers });
  }

  const workflow = await createApprovalWorkflow(
    { organizationId: input.organizationId, requestId: input.requestId, steps },
    tx,
  );

  await writeAudit(
    {
      organizationId: input.organizationId,
      actorId: null,
      actorType: 'SYSTEM',
      action: AUDIT_ACTION.APPROVAL_REQUESTED,
      entityType: AUDIT_ENTITY.APPROVAL_WORKFLOW,
      entityId: workflow.id,
      after: {
        requestId: input.requestId,
        steps: steps.map((step) => ({ stepOrder: step.stepOrder, mode: step.mode })),
      },
      correlationId: meta.correlationId,
      sourceIp: meta.sourceIp ?? null,
      userAgent: meta.userAgent ?? null,
    },
    tx,
  );

  await writeOutboxEvent(
    {
      organizationId: input.organizationId,
      eventType: OUTBOX_EVENT.APPROVAL_REQUESTED,
      idempotencyKey: `approval.requested:${workflow.id}:${steps[0]?.stepOrder ?? 1}`,
      payload: {
        workflowId: workflow.id,
        requestId: input.requestId,
        stepOrder: steps[0]?.stepOrder ?? 1,
        approverIds: steps[0]?.approverIds ?? [],
      },
    },
    tx,
  );
}

// ===========================================================================
// Views
// ===========================================================================

export interface ApprovalDecisionView {
  id: string;
  outcome: string;
  comment: string | null;
  decidedAt: Date;
  approver: { id: string; displayName: string };
}

export interface ApprovalStepView {
  id: string;
  stepOrder: number;
  mode: string;
  status: string;
  approvers: Array<{ id: string; displayName: string }>;
  decisions: ApprovalDecisionView[];
}

export interface ApprovalWorkflowView {
  id: string;
  request: { id: string; reference: string; title: string };
  status: string;
  currentStepOrder: number;
  steps: ApprovalStepView[];
  createdAt: Date;
  completedAt: Date | null;
}

function toDecisionView(decision: DecisionWithApprover): ApprovalDecisionView {
  return {
    id: decision.id,
    outcome: decision.outcome,
    comment: decision.comment,
    decidedAt: decision.decidedAt,
    approver: { id: decision.approver.id, displayName: decision.approver.displayName },
  };
}

function toWorkflowView(workflow: ApprovalWorkflowWithRelations): ApprovalWorkflowView {
  return {
    id: workflow.id,
    request: {
      id: workflow.request.id,
      reference: workflow.request.reference,
      title: workflow.request.title,
    },
    status: workflow.status,
    currentStepOrder: workflow.currentStepOrder,
    steps: workflow.steps.map((step) => ({
      id: step.id,
      stepOrder: step.stepOrder,
      mode: step.mode,
      status: step.status,
      approvers: step.approvers.map((entry) => ({
        id: entry.approver.id,
        displayName: entry.approver.displayName,
      })),
      decisions: step.decisions.map(toDecisionView),
    })),
    createdAt: workflow.createdAt,
    completedAt: workflow.completedAt,
  };
}

/**
 * Pending decisions for the caller (`docs/26` §11): only the steps the caller is a
 * designated approver for, on active workflows — an approver cannot see work that is not
 * theirs.
 */
export async function listPendingApprovals(actor: Principal): Promise<ApprovalWorkflowView[]> {
  requireTenant(actor);
  assertAnyPermission(actor, ['approval:decide', 'approval:read.pending']);
  const workflows = await listActiveStepsForApprover(actor.organizationId as string, actor.userId);
  return (
    workflows
      .map(toWorkflowView)
      // The inbox lists the caller's own steps only; other steps are not their business.
      .map((view) => ({
        ...view,
        steps: view.steps.filter(
          (step) =>
            step.status !== 'ACTIVE' ||
            step.approvers.some((approver) => approver.id === actor.userId),
        ),
      }))
  );
}

/** The workflow for a request, subject to visibility rule A5 (`docs/26` §8). */
export async function getRequestApprovals(
  requestId: string,
  actor: Principal,
): Promise<ApprovalWorkflowView | null> {
  requireTenant(actor);
  const workflow = await findWorkflowByRequestId(requestId);
  if (!workflow || workflow.organizationId !== actor.organizationId) {
    throw new NotFoundError('Approval workflow not found.');
  }

  const isDesignated = workflow.steps.some((step) =>
    step.approvers.some((entry) => entry.approverId === actor.userId),
  );
  const privileged =
    hasPermission(actor, 'approval:read.pending') || hasPermission(actor, 'approval:reassign');
  // A5: pending approval detail is visible only to designated approvers and leads/admins.
  if (!isDesignated && !privileged) {
    throw new NotFoundError('Approval workflow not found.');
  }
  return toWorkflowView(workflow);
}

// ===========================================================================
// Decisions
// ===========================================================================

export interface DecideResult {
  workflow: ApprovalWorkflowView;
  /** True when this call recorded a new decision; false on an idempotent replay. */
  recorded: boolean;
}

/**
 * Records a decision on the active step (`docs/26` §5).
 *
 * The checks run in the order that names the real obstacle: the step must be the active
 * one (else `409`), the caller must be a designated approver (else `403`), self-approval
 * is refused (A), a rejection needs a comment (`422`), and a replayed decision returns the
 * original outcome rather than recording twice (idempotency).
 */
export async function decideApprovalStep(
  stepId: string,
  input: { decision: 'APPROVE' | 'REJECT'; comment?: string },
  actor: Principal,
  meta: RequestMeta,
): Promise<DecideResult> {
  requireTenant(actor);
  assertPermission(actor, 'approval:decide');

  const workflow = await findWorkflowForStep(stepId);
  if (!workflow || workflow.organizationId !== actor.organizationId) {
    throw new NotFoundError('Approval step not found.');
  }

  // Idempotency is checked FIRST (docs/26 §5): replaying the same decision returns the
  // original outcome rather than recording twice — even after the step has advanced, which
  // is exactly when a retry is most likely.
  const existing = await findDecisionByApproverForStep(stepId, actor.userId);
  if (existing) {
    const fresh = await findWorkflowById(workflow.id);
    return { workflow: toWorkflowView(fresh as ApprovalWorkflowWithRelations), recorded: false };
  }

  if (workflow.status !== 'PENDING') {
    throw new IllegalTransitionError('This workflow has already been decided.');
  }

  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!step || step.status !== 'ACTIVE') {
    // A decision on a superseded step is not recorded (docs/26 §5).
    throw new IllegalTransitionError('That approval step is no longer active.');
  }
  if (!step.approvers.some((entry) => entry.approverId === actor.userId)) {
    throw new ForbiddenError('You are not a designated approver for this step.');
  }
  if (workflow.request.requesterId === actor.userId) {
    // Self-approval is impossible, even when listed (docs/07 §5).
    throw new ForbiddenError('A requester cannot approve their own request.');
  }
  if (input.decision === 'REJECT' && !input.comment) {
    throw new ValidationError([
      { field: 'comment', code: 'REQUIRED', message: 'A comment is required to reject.' },
    ]);
  }

  const now = new Date();
  const organizationId = workflow.organizationId;

  await runInTransaction(async (tx) => {
    await createApprovalDecision(
      {
        organizationId,
        workflowId: workflow.id,
        stepId: step.id,
        approverId: actor.userId,
        outcome: input.decision,
        comment: input.comment ?? null,
      },
      tx,
    );

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.APPROVAL_DECISION,
        entityType: AUDIT_ENTITY.APPROVAL_DECISION,
        entityId: step.id,
        after: { outcome: input.decision, stepOrder: step.stepOrder },
        ...(input.comment ? { reason: input.comment } : {}),
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    if (input.decision === 'REJECT') {
      const claimed = await claimStepForCompletion(step.id, 'REJECTED', tx);
      if (claimed.count === 0) {
        throw new ConflictError('Another decision already completed this step.');
      }
      await cancelRemainingSteps(workflow.id, step.stepOrder + 1, tx);
      await completeWorkflow(workflow.id, 'REJECTED', now, tx);
      await applyRequestOutcome(tx, workflow, 'REJECTED', actor, meta, now);
      return;
    }

    // APPROVE
    if (step.mode === 'ALL') {
      const approvals = await countStepDecisions(step.id, 'APPROVE', tx);
      if (approvals < step.approvers.length) {
        // More approvers must still act; the step stays active.
        return;
      }
    }
    const claimed = await claimStepForCompletion(step.id, 'COMPLETED', tx);
    if (claimed.count === 0) {
      // An `ANY` step already satisfied by a concurrent decision (docs/26 §5).
      throw new ConflictError('Another decision already advanced this step.');
    }
    await advanceOrFinalize(tx, workflow, step.stepOrder, actor, meta, now);
  });

  const fresh = await findWorkflowById(workflow.id);
  return { workflow: toWorkflowView(fresh as ApprovalWorkflowWithRelations), recorded: true };
}

/** Activates the next step, or finalizes the workflow as approved (`docs/26` §4). */
async function advanceOrFinalize(
  tx: TxClient,
  workflow: ApprovalWorkflowWithRelations,
  completedStepOrder: number,
  actor: Principal,
  meta: RequestMeta,
  now: Date,
): Promise<void> {
  const next = workflow.steps.find((step) => step.stepOrder > completedStepOrder);
  if (next) {
    await activateStep(workflow.id, next.stepOrder, tx);
    await setWorkflowCurrentStep(workflow.id, next.stepOrder, tx);
    await writeAudit(
      {
        organizationId: workflow.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.APPROVAL_STEP_ADVANCED,
        entityType: AUDIT_ENTITY.APPROVAL_WORKFLOW,
        entityId: workflow.id,
        after: { currentStepOrder: next.stepOrder },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: workflow.organizationId,
        eventType: OUTBOX_EVENT.APPROVAL_STEP_ADVANCED,
        idempotencyKey: `approval.advanced:${workflow.id}:${next.stepOrder}`,
        payload: {
          workflowId: workflow.id,
          requestId: workflow.request.id,
          stepOrder: next.stepOrder,
          approverIds: next.approvers.map((entry) => entry.approverId),
        },
      },
      tx,
    );
    return;
  }

  await completeWorkflow(workflow.id, 'APPROVED', now, tx);
  await applyRequestOutcome(tx, workflow, 'APPROVED', actor, meta, now);
}

/**
 * Applies a final approval/rejection to the host request: status change, clock resume and
 * the notification event. Shared by both terminal paths so they cannot drift.
 */
async function applyRequestOutcome(
  tx: TxClient,
  workflow: ApprovalWorkflowWithRelations,
  outcome: 'APPROVED' | 'REJECTED',
  actor: Principal,
  meta: RequestMeta,
  now: Date,
): Promise<void> {
  await updateServiceRequest(workflow.request.id, { status: outcome }, tx);

  // The request left APPROVAL_PENDING, so the clock resumes (docs/25 §3).
  await resumeClock('ServiceRequest', workflow.request.id, now, tx);

  await writeAudit(
    {
      organizationId: workflow.organizationId,
      actorId: actor.userId,
      actorType: 'USER',
      action: AUDIT_ACTION.APPROVAL_FINAL,
      entityType: AUDIT_ENTITY.REQUEST,
      entityId: workflow.request.id,
      after: { status: outcome, workflowId: workflow.id },
      correlationId: meta.correlationId,
      sourceIp: meta.sourceIp ?? null,
      userAgent: meta.userAgent ?? null,
    },
    tx,
  );

  await writeOutboxEvent(
    {
      organizationId: workflow.organizationId,
      eventType:
        outcome === 'APPROVED' ? OUTBOX_EVENT.APPROVAL_APPROVED : OUTBOX_EVENT.APPROVAL_REJECTED,
      idempotencyKey: `approval.final:${workflow.id}:${outcome}`,
      payload: {
        workflowId: workflow.id,
        requestId: workflow.request.id,
        reference: workflow.request.reference,
        // The outcome is addressed to the person who raised the request (`docs/29` §5):
        // the id travels on the event and the worker resolves the address at send time.
        requesterId: workflow.request.requesterId,
        outcome,
      },
    },
    tx,
  );
}

// ===========================================================================
// Reassignment (rule A8)
// ===========================================================================

/** Reassigns an active step to a new set of approvers; audited (`docs/26` §10). */
export async function reassignApprovalStep(
  stepId: string,
  input: { approverIds: string[] },
  actor: Principal,
  meta: RequestMeta,
): Promise<ApprovalWorkflowView> {
  requireTenant(actor);
  assertPermission(actor, 'approval:reassign');

  const workflow = await findWorkflowForStep(stepId);
  if (!workflow || workflow.organizationId !== actor.organizationId) {
    throw new NotFoundError('Approval step not found.');
  }
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!step || step.status !== 'ACTIVE') {
    throw new IllegalTransitionError('Only an active step can be reassigned.');
  }

  // A reassigned approver must be an active member of the tenant, and never the requester.
  const eligible = input.approverIds.filter((id) => id !== workflow.request.requesterId);
  if (eligible.length === 0) {
    throw new ValidationError([
      { field: 'approverIds', code: 'EMPTY', message: 'Provide at least one eligible approver.' },
    ]);
  }

  await runInTransaction(async (tx) => {
    await replaceStepApprovers(step.id, eligible, tx);
    await writeAudit(
      {
        organizationId: workflow.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.APPROVAL_REASSIGN,
        entityType: AUDIT_ENTITY.APPROVAL_STEP,
        entityId: step.id,
        before: { approverIds: step.approvers.map((entry) => entry.approverId) },
        after: { approverIds: eligible },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: workflow.organizationId,
        eventType: OUTBOX_EVENT.APPROVAL_REASSIGNED,
        idempotencyKey: `approval.reassigned:${step.id}:${Date.now()}`,
        payload: {
          workflowId: workflow.id,
          stepId: step.id,
          approverIds: eligible,
          // Without the request id the reassignment notification had no link to follow.
          requestId: workflow.request.id,
          reference: workflow.request.reference,
        },
      },
      tx,
    );
  });

  const fresh = await findWorkflowById(workflow.id);
  return toWorkflowView(fresh as ApprovalWorkflowWithRelations);
}

/** Cancels a pending workflow (e.g. the request was cancelled). Findings are recorded. */
export async function cancelWorkflowForRequest(
  requestId: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<void> {
  const workflow = await findWorkflowByRequestId(requestId);
  if (!workflow || workflow.status !== 'PENDING') {
    return;
  }
  const now = new Date();
  await runInTransaction(async (tx) => {
    await cancelRemainingSteps(workflow.id, 1, tx);
    await completeWorkflow(workflow.id, 'CANCELLED', now, tx);
    await writeAudit(
      {
        organizationId: workflow.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.APPROVAL_CANCELLED,
        entityType: AUDIT_ENTITY.APPROVAL_WORKFLOW,
        entityId: workflow.id,
        after: { status: 'CANCELLED' },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });
}

// ===========================================================================
// Templates
// ===========================================================================

export interface ApprovalTemplateView {
  id: string;
  catalogItemId: string;
  name: string;
  isActive: boolean;
  steps: Array<{ stepOrder: number; mode: string; approverRoleKey: string }>;
}

export async function listTemplates(actor: Principal): Promise<ApprovalTemplateView[]> {
  requireTenant(actor);
  assertPermission(actor, 'admin:config');
  const templates = await listApprovalTemplates(actor.organizationId as string);
  return templates.map((template) => ({
    id: template.id,
    catalogItemId: template.catalogItemId,
    name: template.name,
    isActive: template.isActive,
    steps: template.steps.map((step) => ({
      stepOrder: step.stepOrder,
      mode: step.mode,
      approverRoleKey: step.approverRoleKey,
    })),
  }));
}

export async function createTemplate(
  input: {
    catalogItemId: string;
    name: string;
    isActive: boolean;
    steps: TemplateStepInput[];
  },
  actor: Principal,
  meta: RequestMeta,
): Promise<ApprovalTemplateView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'admin:config');

  const existing = await findTemplateForCatalogItem(input.catalogItemId);
  if (existing) {
    throw new ConflictError('This service already has an approval template.');
  }

  const created = await runInTransaction(async (tx) => {
    const template = await createApprovalTemplate({ organizationId, ...input }, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.APPROVAL_TEMPLATE_CREATE,
        entityType: AUDIT_ENTITY.APPROVAL_TEMPLATE,
        entityId: template.id,
        after: { catalogItemId: input.catalogItemId, steps: input.steps.length },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return template;
  });

  return {
    id: created.id,
    catalogItemId: created.catalogItemId,
    name: created.name,
    isActive: created.isActive,
    steps: created.steps.map((step) => ({
      stepOrder: step.stepOrder,
      mode: step.mode,
      approverRoleKey: step.approverRoleKey,
    })),
  };
}

// ===========================================================================
// Internals
// ===========================================================================

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can work with approvals.');
  }
  return actor.organizationId;
}
