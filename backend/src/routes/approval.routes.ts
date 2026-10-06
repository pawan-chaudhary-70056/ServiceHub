import { Router } from 'express';
import {
  getPendingApprovals,
  getTemplates,
  postDecision,
  postReassign,
  postTemplate,
} from '../controllers/approval.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  createApprovalTemplateSchema,
  decideApprovalSchema,
  reassignApprovalStepSchema,
} from '../validators/approval.validators';

/**
 * Approval routes (docs/26 §11).
 *
 * Deciding is guarded by `approval:decide`; the service then applies the object-level rule
 * that only a **designated approver for the active step** may decide, and never the
 * requester (`docs/07` §5). Reassignment is guarded by `approval:reassign`.
 */
export const approvalRouter = Router();
approvalRouter.use(authenticate);

approvalRouter.get('/pending', requirePermission('approval:decide'), getPendingApprovals);
approvalRouter.post(
  '/:id/decide',
  requirePermission('approval:decide'),
  csrfProtection,
  validate({ params: idParamsSchema, body: decideApprovalSchema }),
  postDecision,
);
approvalRouter.post(
  '/:id/reassign',
  requirePermission('approval:reassign'),
  csrfProtection,
  validate({ params: idParamsSchema, body: reassignApprovalStepSchema }),
  postReassign,
);

/**
 * Admin template surface (docs/26 §11). Guarded by `admin:config`; mounted at `/admin`.
 */
export const adminApprovalRouter = Router();
adminApprovalRouter.use(authenticate);
adminApprovalRouter.get('/approval-templates', requirePermission('admin:config'), getTemplates);
adminApprovalRouter.post(
  '/approval-templates',
  requirePermission('admin:config'),
  csrfProtection,
  validate({ body: createApprovalTemplateSchema }),
  postTemplate,
);
