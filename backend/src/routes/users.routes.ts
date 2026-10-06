import { Router } from 'express';
import { getUsers, postDeactivateUser, postInviteUser } from '../controllers/users.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { cursorPaginationSchema, idParamsSchema } from '../validators';
import { inviteUserSchema } from '../validators/platform.validators';

/**
 * Tenant user-administration routes (docs/11 §9, docs/07).
 *
 * The coarse check here is `user:manage`; the authoritative tenant/object scope check
 * happens in the service, which refuses a caller with no organization (docs/07 §6).
 * The read is a safe method; the mutations are CSRF-protected.
 */
export const usersRouter = Router();

usersRouter.use(authenticate);

const manageUsers = requirePermission('user:manage');

usersRouter.get('/', manageUsers, validate({ query: cursorPaginationSchema.strict() }), getUsers);
usersRouter.post(
  '/',
  manageUsers,
  csrfProtection,
  validate({ body: inviteUserSchema }),
  postInviteUser,
);
usersRouter.post(
  '/:id/deactivate',
  manageUsers,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postDeactivateUser,
);
