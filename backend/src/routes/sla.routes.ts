import { Router } from 'express';
import {
  getCalendars,
  getClockById,
  getPolicies,
  getPolicyById,
  patchCalendar,
  patchPolicy,
  postCalendar,
  postClockOverride,
  postPolicy,
} from '../controllers/sla.controller';
import { INCIDENT_READ_PERMISSIONS, REQUEST_READ_PERMISSIONS } from '../helpers/authorization';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  createBusinessCalendarSchema,
  createSlaPolicySchema,
  overrideSlaClockSchema,
  updateBusinessCalendarSchema,
  updateSlaPolicySchema,
} from '../validators/sla.validators';

/**
 * SLA routes (docs/25 §11).
 *
 * Two permission levels, and the split is deliberate:
 *
 *   - **configuration** (`/policies`, `/calendars`) is administrator work and requires
 *     `sla:policy:manage`, which no requester or approver holds (`docs/07` §3);
 *   - **a clock** is read under the *record's* read scope — the indicator is in every
 *     detail header (`§12`), so an agent must be able to read it — while overriding one
 *     requires `sla:clock:override`. The service then applies the record's tenant and
 *     object-level rule, so neither route can be used to reach a record the caller cannot
 *     already see (`docs/17`).
 *
 * Mutations are CSRF-protected.
 */
export const slaRouter = Router();

slaRouter.use(authenticate);

const manage = requirePermission('sla:policy:manage');
const readRecord = requireAnyPermission([
  ...REQUEST_READ_PERMISSIONS,
  ...INCIDENT_READ_PERMISSIONS,
]);

slaRouter.get('/calendars', manage, getCalendars);
slaRouter.post(
  '/calendars',
  manage,
  csrfProtection,
  validate({ body: createBusinessCalendarSchema }),
  postCalendar,
);
// A calendar edit is a new version, never an edit of the row in flight records were
// computed against (docs/25 §4 rule 6, §11).
slaRouter.patch(
  '/calendars/:id',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: updateBusinessCalendarSchema }),
  patchCalendar,
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

// The clock on a record (docs/25 §11): read under the record's own scope, override under
// `sla:clock:override`, which the permission catalogue grants to leads and administrators.
slaRouter.get('/clocks/:id', readRecord, validate({ params: idParamsSchema }), getClockById);
slaRouter.post(
  '/clocks/:id/override',
  requirePermission('sla:clock:override'),
  csrfProtection,
  validate({ params: idParamsSchema, body: overrideSlaClockSchema }),
  postClockOverride,
);
