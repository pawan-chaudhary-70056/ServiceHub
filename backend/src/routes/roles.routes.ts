import { Router } from 'express';
import { getAssignableRoles } from '../controllers/roles.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';

/**
 * Tenant roles routes (docs/11 §9, docs/07 §3).
 *
 * Read-only and safe, so no CSRF token is required. The permission `user:manage` matches
 * the invite flow that consumes this list; the service also enforces tenant scope, so a
 * platform operator receives nothing (`07` §5).
 */
export const rolesRouter = Router();

rolesRouter.use(authenticate);

rolesRouter.get('/', requirePermission('user:manage'), getAssignableRoles);
