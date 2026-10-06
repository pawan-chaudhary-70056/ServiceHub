import { Router } from 'express';
import {
  getCalendars,
  getPolicies,
  getPolicyById,
  patchPolicy,
  postCalendar,
  postPolicy,
} from '../controllers/sla.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  createBusinessCalendarSchema,
  createSlaPolicySchema,
  updateSlaPolicySchema,
} from '../validators/sla.validators';

/**
 * SLA configuration routes (docs/25 §11).
 *
 * SLA configuration is administrator work: every route requires `sla:policy:manage`,
 * which no requester or approver holds (docs/07 §3). Mutations are CSRF-protected.
 */
export const slaRouter = Router();

slaRouter.use(authenticate);

const manage = requirePermission('sla:policy:manage');

slaRouter.get('/calendars', manage, getCalendars);
slaRouter.post(
  '/calendars',
  manage,
  csrfProtection,
  validate({ body: createBusinessCalendarSchema }),
  postCalendar,
);

slaRouter.get('/policies', manage, getPolicies);
slaRouter.post(
  '/policies',
  manage,
  csrfProtection,
  validate({ body: createSlaPolicySchema }),
  postPolicy,
);
slaRouter.get('/policies/:id', manage, validate({ params: idParamsSchema }), getPolicyById);
slaRouter.patch(
  '/policies/:id',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: updateSlaPolicySchema }),
  patchPolicy,
);
