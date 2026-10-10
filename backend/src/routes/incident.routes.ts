import { Router } from 'express';
import {
  getComments,
  getHistory,
  getIncidentById,
  getIncidents,
  patchIncident,
  postAssign,
  postClose,
  postComment,
  postIncident,
  postMajor,
  postReopen,
  postResolve,
} from '../controllers/incident.controller';
import { getIncidentTasks, postIncidentTask } from '../controllers/task.controller';
import { getIncidentKnowledgeLinks, postIncidentKnowledgeLink } from '../controllers/kb.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/authorize';
import { INCIDENT_READ_PERMISSIONS } from '../helpers/authorization';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { createTaskSchema } from '../validators/task.validators';
import { knowledgeLinkSchema } from '../validators/kb.validators';
import { cursorPaginationSchema, idParamsSchema } from '../validators';
import {
  assignIncidentSchema,
  commentSchema,
  createIncidentSchema,
  listIncidentsQuerySchema,
  majorIncidentSchema,
  reopenIncidentSchema,
  resolveIncidentSchema,
  updateIncidentSchema,
} from '../validators/incident.validators';

/**
 * Incident routes (docs/23 §10, docs/11 §9).
 *
 * Reporting is open to any authenticated user (`incident:create`); everything else is
 * scoped and permissioned. The authoritative object-level scope, the derivation matrix
 * and the state machine are enforced in the service (docs/07 §6). Mutations are
 * CSRF-protected.
 */
export const incidentRouter = Router();

incidentRouter.use(authenticate);

// Reading is one capability expressed as three scoped grants (`07` §3): a reporter holds
// `incident:read.own`, an agent `.team`, a lead/admin/auditor `.any`.
const readAny = requireAnyPermission(INCIDENT_READ_PERMISSIONS);

incidentRouter.get('/', readAny, validate({ query: listIncidentsQuerySchema }), getIncidents);
incidentRouter.post(
  '/',
  requirePermission('incident:create'),
  csrfProtection,
  validate({ body: createIncidentSchema }),
  postIncident,
);

incidentRouter.get('/:id', readAny, validate({ params: idParamsSchema }), getIncidentById);
incidentRouter.patch(
  '/:id',
  readAny,
  csrfProtection,
  validate({ params: idParamsSchema, body: updateIncidentSchema }),
  patchIncident,
);
incidentRouter.post(
  '/:id/assign',
  requirePermission('incident:update.any'),
  csrfProtection,
  validate({ params: idParamsSchema, body: assignIncidentSchema }),
  postAssign,
);
incidentRouter.post(
  '/:id/resolve',
  requirePermission('incident:update.any'),
  csrfProtection,
  validate({ params: idParamsSchema, body: resolveIncidentSchema }),
  postResolve,
);
incidentRouter.post(
  '/:id/close',
  readAny,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postClose,
);
incidentRouter.post(
  '/:id/reopen',
  readAny,
  csrfProtection,
  validate({ params: idParamsSchema, body: reopenIncidentSchema }),
  postReopen,
);
incidentRouter.post(
  '/:id/major',
  requirePermission('incident:update.any'),
  csrfProtection,
  validate({ params: idParamsSchema, body: majorIncidentSchema }),
  postMajor,
);

incidentRouter.get(
  '/:id/comments',
  readAny,
  validate({ params: idParamsSchema, query: cursorPaginationSchema.strict() }),
  getComments,
);
incidentRouter.post(
  '/:id/comments',
  readAny,
  csrfProtection,
  validate({ params: idParamsSchema, body: commentSchema }),
  postComment,
);

incidentRouter.get(
  '/:id/history',
  readAny,
  validate({ params: idParamsSchema, query: cursorPaginationSchema.strict() }),
  getHistory,
);

// Child tasks (docs/24 §9). Reading inherits the incident's scope; creation needs
// `task:create`, and the service refuses a terminal parent with `409`.
incidentRouter.get('/:id/tasks', readAny, validate({ params: idParamsSchema }), getIncidentTasks);
incidentRouter.post(
  '/:id/tasks',
  requirePermission('task:create'),
  csrfProtection,
  validate({ params: idParamsSchema, body: createTaskSchema }),
  postIncidentTask,
);

// Linked knowledge articles (docs/27 §8, rule K6). The incident's own scope decides who
// may see or add a link.
incidentRouter.get(
  '/:id/knowledge-links',
  readAny,
  validate({ params: idParamsSchema }),
  getIncidentKnowledgeLinks,
);
incidentRouter.post(
  '/:id/knowledge-links',
  requirePermission('kb:article:read'),
  csrfProtection,
  validate({ params: idParamsSchema, body: knowledgeLinkSchema }),
  postIncidentKnowledgeLink,
);
