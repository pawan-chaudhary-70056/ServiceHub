import { Router } from 'express';
import {
  getComments,
  getRequestById,
  getRequests,
  postAssign,
  postCancel,
  postComment,
  postRequest,
  postTransition,
} from '../controllers/request.controller';
import { getApprovalsForRequest } from '../controllers/approval.controller';
import { getRequestTasks, postRequestTask } from '../controllers/task.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/authorize';
import { REQUEST_READ_PERMISSIONS } from '../helpers/authorization';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { createTaskSchema } from '../validators/task.validators';
import { cursorPaginationSchema, idParamsSchema } from '../validators';
import {
  assignRequestSchema,
  cancelRequestSchema,
  commentSchema,
  createRequestSchema,
  listRequestsQuerySchema,
  transitionRequestSchema,
} from '../validators/request.validators';

/**
 * Service request routes (docs/22 §11, docs/11 §9).
 *
 * The coarse permissions here are deliberately permissive (`request:read.own`,
 * `request:create`); the authoritative object-level scope (`own`/`team`/`any`), the state
 * machine and the assignment rules are enforced in the service, which is where the record
 * is known (docs/07 §6). Mutations are CSRF-protected.
 */
export const requestRouter = Router();

requestRouter.use(authenticate);

// Reading is one capability expressed as three scoped grants (`07` §3): a requester
// holds `request:read.own`, an agent `.team`, an admin/auditor `.any`. The service then
// applies the precise object-level scope.
const readAny = requireAnyPermission(REQUEST_READ_PERMISSIONS);

requestRouter.get('/', readAny, validate({ query: listRequestsQuerySchema }), getRequests);
requestRouter.post(
  '/',
  requirePermission('request:create'),
  csrfProtection,
  validate({ body: createRequestSchema }),
  postRequest,
);

requestRouter.get('/:id', readAny, validate({ params: idParamsSchema }), getRequestById);
requestRouter.post(
  '/:id/transition',
  readAny,
  csrfProtection,
  validate({ params: idParamsSchema, body: transitionRequestSchema }),
  postTransition,
);
requestRouter.post(
  '/:id/assign',
  requirePermission('request:assign'),
  csrfProtection,
  validate({ params: idParamsSchema, body: assignRequestSchema }),
  postAssign,
);
requestRouter.post(
  '/:id/cancel',
  readAny,
  csrfProtection,
  validate({ params: idParamsSchema, body: cancelRequestSchema }),
  postCancel,
);

requestRouter.get(
  '/:id/comments',
  readAny,
  validate({ params: idParamsSchema, query: cursorPaginationSchema.strict() }),
  getComments,
);
requestRouter.post(
  '/:id/comments',
  readAny,
  csrfProtection,
  validate({ params: idParamsSchema, body: commentSchema }),
  postComment,
);

// Approval workflow for the request (docs/26 §11). Visibility is A5: designated
// approvers and leads/admins; anyone else receives 404.
requestRouter.get(
  '/:id/approvals',
  readAny,
  validate({ params: idParamsSchema }),
  getApprovalsForRequest,
);

// Child tasks (docs/24 §9). Reading inherits the parent's scope; creation needs
// `task:create`, and the service refuses a terminal parent with `409`.
requestRouter.get('/:id/tasks', readAny, validate({ params: idParamsSchema }), getRequestTasks);
requestRouter.post(
  '/:id/tasks',
  requirePermission('task:create'),
  csrfProtection,
  validate({ params: idParamsSchema, body: createTaskSchema }),
  postRequestTask,
);
