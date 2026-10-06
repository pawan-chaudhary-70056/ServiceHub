import { Router } from 'express';
import {
  getReport,
  getReportExport,
  getReportExportDownload,
  getSearch,
  postReportExport,
} from '../controllers/search.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  reportParamsSchema,
  reportQuerySchema,
  searchQuerySchema,
} from '../validators/search.validators';

/**
 * Search, reporting, and report export routes (docs/30 §5, docs/11 §9).
 *
 * Search carries **no single permission**: the entitlement is the entitlement to the
 * underlying records, and the service applies each source's own scope (docs/30 §4). Reports
 * are guarded by `report:read`; exports by `report:export`, and the service additionally
 * scopes the job to the requester.
 *
 * Mounted at the API root, so authentication is applied **per route**, never with
 * `router.use`: a root-level `use(authenticate)` would authenticate every unmatched path
 * too and turn a 404 into a 401.
 */
export const searchRouter = Router();

searchRouter.get('/search', authenticate, validate({ query: searchQuerySchema }), getSearch);

searchRouter.get(
  '/reports/:metric',
  authenticate,
  requirePermission('report:read'),
  validate({ params: reportParamsSchema, query: reportQuerySchema }),
  getReport,
);

// Export jobs are addressed under `/reports/jobs/...`, which cannot collide with the
// single-segment `/reports/:metric` route.
searchRouter.get(
  '/reports/jobs/:id',
  authenticate,
  requirePermission('report:export'),
  validate({ params: idParamsSchema }),
  getReportExport,
);
searchRouter.get(
  '/reports/jobs/:id/download',
  authenticate,
  requirePermission('report:export'),
  validate({ params: idParamsSchema }),
  getReportExportDownload,
);
searchRouter.post(
  '/reports/:metric/export',
  authenticate,
  requirePermission('report:export'),
  csrfProtection,
  validate({ params: reportParamsSchema, body: reportQuerySchema }),
  postReportExport,
);
