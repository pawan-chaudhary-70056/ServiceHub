import type { Request, Response } from 'express';
import {
  createTemplate,
  decideApprovalStep,
  getRequestApprovals,
  listPendingApprovals,
  listTemplates,
  reassignApprovalStep,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  CreateApprovalTemplateInput,
  DecideApprovalInput,
  ReassignApprovalStepInput,
} from '../validators/approval.validators';
import { requestMeta } from './support';

/**
 * Approval endpoints (docs/26 §11, docs/11 §9).
 *
 * `{id}` on the decision routes is the **step** id: a decision is recorded against the
 * active step, and only a designated approver for that step may make it — enforced in the
 * service, which knows the snapshot.
 */

/** `GET /approvals/pending` — the caller's own pending decisions. */
export async function getPendingApprovals(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listPendingApprovals(req.actor);
  res.status(200).json({ items });
}

/** `GET /requests/{id}/approvals` — the workflow for a request (visibility per A5). */
export async function getApprovalsForRequest(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const workflow = await getRequestApprovals(params.id, req.actor);
  res.status(200).json({ workflow });
}

/** `POST /approvals/{id}/decide` — records an approve/reject decision on the step. */
export async function postDecision(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<DecideApprovalInput, { id: string }>(res);
  const result = await decideApprovalStep(params.id, body, req.actor, requestMeta(req));
  res.status(200).json(result);
}

/** `POST /approvals/{id}/reassign` — replaces the step's approver snapshot. */
export async function postReassign(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<ReassignApprovalStepInput, { id: string }>(res);
  const workflow = await reassignApprovalStep(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ workflow });
}

/** `GET /admin/approval-templates` — tenant approval templates. */
export async function getTemplates(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listTemplates(req.actor);
  res.status(200).json({ items });
}

/** `POST /admin/approval-templates` — creates a template for a catalog item. */
export async function postTemplate(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateApprovalTemplateInput>(res);
  const template = await createTemplate(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/admin/approval-templates/${template.id}`);
  res.status(201).json({ template });
}
