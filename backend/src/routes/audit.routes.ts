import { Router } from 'express';
import {
  getAudit,
  getAuditExportDownload,
  getAuditExportStatus,
  getRecordAudit,
  getSecurityAudit,
  postAuditExport,
} from '../controllers/audit.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { cursorPaginationSchema } from '../validators';
import {
  auditExportBodySchema,
  auditExportParamsSchema,
  auditListQuerySchema,
  auditRecordParamsSchema,
  auditRecordQuerySchema,
} from '../validators/audit.validators';

/**
 * Audit explorer routes (docs/31 §10, docs/11 §9).
 *
 * Reading the log is one capability expressed as two scoped grants (`docs/07` §3): a team
 * lead holds `audit:read.team`, a security role holds `audit:read.all`. The service applies
 * the scope, returns `404`-equivalent emptiness for an actor outside it, and withholds the
 * security class from a caller without `audit:read.security`.
 *
 * There is **no mutation route** on this surface: `docs/31` §9 states that no permission
 * exists to modify an audit entry, and the database trigger is the enforcement.
 */
export const auditRouter = Router();

auditRouter.use(authenticate);

const read = requireAnyPermission(['audit:read.team', 'audit:read.all']);

auditRouter.get('/', read, validate({ query: auditListQuerySchema }), getAudit);
auditRouter.get(
  '/security',
  requirePermission('audit:read.security'),
  validate({ query: cursorPaginationSchema.strict() }),
  getSecurityAudit,
);
// Note the absence of a route-level audit permission: `docs/31` §5 admits *record
// participants* to a record's history, and that entitlement is the record's own, resolved
// by the owning service's object-level check (`getRecordHistoryForCaller`). A caller with
// neither an audit grant nor access to the record is refused in the service, so this route
// is authenticated but not audit-gated — adding the guard back here would silently exclude
// every participant the specification means to include.
auditRouter.get(
  '/records/:entityType/:entityId',
  validate({ params: auditRecordParamsSchema, query: auditRecordQuerySchema }),
  getRecordAudit,
);

// Audit export (`docs/31` §9/§10). A separate grant from reading: exporting the whole log
// is a disclosure action, not a page view, and it is audited with its filters (§6). The
// job is self-scoped — only the requester may poll or download it (`docs/30` §5).
const exportGrant = requirePermission('audit:export');

auditRouter.post(
  '/export',
  exportGrant,
  csrfProtection,
  validate({ body: auditExportBodySchema }),
  postAuditExport,
);
auditRouter.get(
  '/exports/:id',
  exportGrant,
  validate({ params: auditExportParamsSchema }),
  getAuditExportStatus,
);
auditRouter.get(
  '/exports/:id/download',
  exportGrant,
  validate({ params: auditExportParamsSchema }),
  getAuditExportDownload,
);
