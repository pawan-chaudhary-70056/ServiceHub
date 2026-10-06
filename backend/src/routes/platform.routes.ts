import { Router } from 'express';
import {
  getOperators,
  getOrganizations,
  postActivateOrganization,
  postOrganization,
  postSuspendOrganization,
} from '../controllers/platform.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  createOrganizationSchema,
  listOrganizationsQuerySchema,
} from '../validators/platform.validators';

/**
 * Platform administration routes (`ADR-0012`, docs/11 §9, docs/07).
 *
 * Every route is authenticated and carries an explicit permission. Two distinct
 * capabilities are separated on purpose (docs/07 §5):
 *
 *   - `platform:organization:manage` — provision, suspend, activate, list tenants;
 *   - `platform:operator:manage`     — read the platform operator roster.
 *
 * State-changing routes are CSRF-protected; the read routes are safe methods and are not.
 */
export const platformRouter = Router();

platformRouter.use(authenticate);

const manageOrganizations = requirePermission('platform:organization:manage');

platformRouter.get(
  '/organizations',
  manageOrganizations,
  validate({ query: listOrganizationsQuerySchema }),
  getOrganizations,
);
platformRouter.post(
  '/organizations',
  manageOrganizations,
  csrfProtection,
  validate({ body: createOrganizationSchema }),
  postOrganization,
);
platformRouter.post(
  '/organizations/:id/suspend',
  manageOrganizations,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postSuspendOrganization,
);
platformRouter.post(
  '/organizations/:id/activate',
  manageOrganizations,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postActivateOrganization,
);

platformRouter.get('/operators', requirePermission('platform:operator:manage'), getOperators);
