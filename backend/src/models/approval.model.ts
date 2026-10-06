import type {
  ApprovalDecision,
  ApprovalDecisionOutcome,
  ApprovalMode,
  ApprovalStep,
  ApprovalStepStatus,
  ApprovalTemplate,
  ApprovalTemplateStep,
  ApprovalWorkflow,
  ApprovalWorkflowStatus,
  Prisma,
} from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Approval data access — docs/26, F-09.
 *
 * The properties the database must own here:
 *
 *   - **One workflow per request** (rule A1), by the unique `requestId`.
 *   - **Decisions are insert-only** (rule A3): there is no update or delete path in this
 *     module, and a trigger rejects both at the database.
 *   - **Approvers are a snapshot** (rule A2), stored in `ApprovalStepApprover`, not
 *     re-resolved from roles at decision time.
 *
 * Only `services/` may import this module (`docs/03` §4).
 */

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplateStepInput {
  stepOrder: number;
  mode: ApprovalMode;
  approverRoleKey: string;
}

export interface ApprovalTemplateWithSteps extends ApprovalTemplate {
  steps: ApprovalTemplateStep[];
}

export function createApprovalTemplate(
  data: {
    organizationId: string;
    catalogItemId: string;
    name: string;
    isActive: boolean;
    steps: TemplateStepInput[];
  },
  client: DataClient = prisma,
): Promise<ApprovalTemplateWithSteps> {
  const { steps, ...template } = data;
  return client.approvalTemplate.create({
    data: { ...template, steps: { create: steps } },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });
}

export function findTemplateForCatalogItem(
  catalogItemId: string,
  client: DataClient = prisma,
): Promise<ApprovalTemplateWithSteps | null> {
  return client.approvalTemplate.findUnique({
    where: { catalogItemId },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });
}

export function listApprovalTemplates(
  organizationId: string,
  client: DataClient = prisma,
): Promise<ApprovalTemplateWithSteps[]> {
  return client.approvalTemplate.findMany({
    where: { organizationId },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

// ---------------------------------------------------------------------------
// Workflows and steps
// ---------------------------------------------------------------------------

export interface WorkflowStepInput {
  stepOrder: number;
  mode: ApprovalMode;
  approverIds: string[];
}

export interface DecisionWithApprover extends ApprovalDecision {
  approver: { id: string; displayName: string };
}

export interface ApprovalStepWithApprovers extends ApprovalStep {
  approvers: Array<{ approverId: string; approver: { id: string; displayName: string } }>;
  decisions: DecisionWithApprover[];
}

export interface ApprovalWorkflowWithRelations extends ApprovalWorkflow {
  steps: ApprovalStepWithApprovers[];
  decisions: DecisionWithApprover[];
  request: {
    id: string;
    reference: string;
    title: string;
    requesterId: string;
    organizationId: string;
  };
}

const WORKFLOW_INCLUDE = {
  steps: {
    include: {
      approvers: {
        select: { approverId: true, approver: { select: { id: true, displayName: true } } },
      },
      decisions: {
        orderBy: { decidedAt: 'asc' },
        include: { approver: { select: { id: true, displayName: true } } },
      },
    },
    orderBy: { stepOrder: 'asc' },
  },
  decisions: {
    orderBy: { decidedAt: 'asc' },
    include: { approver: { select: { id: true, displayName: true } } },
  },
  request: {
    select: {
      id: true,
      reference: true,
      title: true,
      requesterId: true,
      organizationId: true,
    },
  },
} satisfies Prisma.ApprovalWorkflowInclude;

/**
 * Creates the workflow, its steps and the snapshot of approvers in one write (`docs/26`
 * §§3–4). The first step is created ACTIVE so the workflow is immediately actionable.
 */
export function createApprovalWorkflow(
  data: {
    organizationId: string;
    requestId: string;
    steps: WorkflowStepInput[];
  },
  client: DataClient = prisma,
): Promise<ApprovalWorkflow> {
  const first = data.steps[0];
  return client.approvalWorkflow.create({
    data: {
      organizationId: data.organizationId,
      requestId: data.requestId,
      status: 'PENDING',
      currentStepOrder: first?.stepOrder ?? 1,
      steps: {
        create: data.steps.map((step) => ({
          stepOrder: step.stepOrder,
          mode: step.mode,
          status: step.stepOrder === first?.stepOrder ? 'ACTIVE' : 'PENDING',
          approvers: { create: step.approverIds.map((approverId) => ({ approverId })) },
        })),
      },
    },
  });
}

export function findWorkflowByRequestId(
  requestId: string,
  client: DataClient = prisma,
): Promise<ApprovalWorkflowWithRelations | null> {
  return client.approvalWorkflow.findUnique({
    where: { requestId },
    include: WORKFLOW_INCLUDE,
  });
}

export function findWorkflowById(
  id: string,
  client: DataClient = prisma,
): Promise<ApprovalWorkflowWithRelations | null> {
  return client.approvalWorkflow.findUnique({ where: { id }, include: WORKFLOW_INCLUDE });
}

export function findWorkflowForStep(
  stepId: string,
  client: DataClient = prisma,
): Promise<ApprovalWorkflowWithRelations | null> {
  return client.approvalWorkflow.findFirst({
    where: { steps: { some: { id: stepId } } },
    include: WORKFLOW_INCLUDE,
  });
}

/**
 * Atomically moves a step out of ACTIVE. Returns the number of rows changed, so a caller
 * can tell whether *it* advanced the step (1) or another concurrent decision already did
 * (0) — which is how two simultaneous decisions on an `ANY` step produce exactly one
 * advance (`docs/26` §5).
 */
export function claimStepForCompletion(
  stepId: string,
  status: Extract<ApprovalStepStatus, 'COMPLETED' | 'REJECTED'>,
  client: DataClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.approvalStep.updateMany({
    where: { id: stepId, status: 'ACTIVE' },
    data: { status },
  });
}

export function activateStep(
  workflowId: string,
  stepOrder: number,
  client: DataClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.approvalStep.updateMany({
    where: { workflowId, stepOrder },
    data: { status: 'ACTIVE' },
  });
}

export function cancelRemainingSteps(
  workflowId: string,
  fromStepOrder: number,
  client: DataClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.approvalStep.updateMany({
    where: { workflowId, stepOrder: { gte: fromStepOrder }, status: { in: ['PENDING', 'ACTIVE'] } },
    data: { status: 'CANCELLED' },
  });
}

export function completeWorkflow(
  id: string,
  status: Extract<ApprovalWorkflowStatus, 'APPROVED' | 'REJECTED' | 'CANCELLED'>,
  completedAt: Date,
  client: DataClient = prisma,
): Promise<ApprovalWorkflow> {
  return client.approvalWorkflow.update({ where: { id }, data: { status, completedAt } });
}

export function setWorkflowCurrentStep(
  id: string,
  currentStepOrder: number,
  client: DataClient = prisma,
): Promise<ApprovalWorkflow> {
  return client.approvalWorkflow.update({ where: { id }, data: { currentStepOrder } });
}

// ---------------------------------------------------------------------------
// Approver snapshot
// ---------------------------------------------------------------------------

/**
 * Replaces a step's approver snapshot. Two statements that must share a transaction; the
 * caller supplies one (`runInTransaction`), so this never nests a `$transaction` on a
 * client that may already be transactional.
 */
export async function replaceStepApprovers(
  stepId: string,
  approverIds: string[],
  client: DataClient = prisma,
): Promise<void> {
  await client.approvalStepApprover.deleteMany({ where: { stepId } });
  if (approverIds.length > 0) {
    await client.approvalStepApprover.createMany({
      data: approverIds.map((approverId) => ({ stepId, approverId })),
      skipDuplicates: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export function createApprovalDecision(
  data: {
    organizationId: string;
    workflowId: string;
    stepId: string;
    approverId: string;
    outcome: ApprovalDecisionOutcome;
    comment: string | null;
  },
  client: DataClient = prisma,
): Promise<ApprovalDecision> {
  return client.approvalDecision.create({ data });
}

export function findDecisionByApproverForStep(
  stepId: string,
  approverId: string,
  client: DataClient = prisma,
): Promise<ApprovalDecision | null> {
  return client.approvalDecision.findFirst({ where: { stepId, approverId } });
}

export function countStepDecisions(
  stepId: string,
  outcome: ApprovalDecisionOutcome,
  client: DataClient = prisma,
): Promise<number> {
  return client.approvalDecision.count({ where: { stepId, outcome } });
}

// ---------------------------------------------------------------------------
// Pending inbox
// ---------------------------------------------------------------------------

/**
 * Active steps this user is a designated approver for. Drives `GET /approvals/pending`
 * (`docs/26` §11): the caller sees only the decisions that are actually theirs.
 */
export function listActiveStepsForApprover(
  organizationId: string,
  approverId: string,
  client: DataClient = prisma,
): Promise<ApprovalWorkflowWithRelations[]> {
  return client.approvalWorkflow.findMany({
    where: {
      organizationId,
      status: 'PENDING',
      steps: { some: { status: 'ACTIVE', approvers: { some: { approverId } } } },
    },
    include: WORKFLOW_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}
