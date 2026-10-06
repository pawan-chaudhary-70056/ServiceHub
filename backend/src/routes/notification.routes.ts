import { Router } from 'express';
import {
  getPreferences,
  listNotifications,
  postReadAllNotifications,
  postReadNotification,
  putPreferences,
} from '../controllers/notification.controller';
import { authenticate } from '../middlewares/authenticate';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  notificationListQuerySchema,
  updatePreferencesSchema,
} from '../validators/notification.validators';

/**
 * Notification centre and preference routes (`docs/29` §12, docs/11 §9).
 *
 * Mounted at the API root, so authentication is applied **per route**, never with
 * `router.use` — a root-level `use(authenticate)` would authenticate every unmatched path
 * and turn a 404 into a 401.
 */
export const notificationRouter = Router();

notificationRouter.get(
  '/notifications',
  authenticate,
  validate({ query: notificationListQuerySchema }),
  listNotifications,
);
notificationRouter.post(
  '/notifications/read-all',
  authenticate,
  csrfProtection,
  postReadAllNotifications,
);
notificationRouter.post(
  '/notifications/:id/read',
  authenticate,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postReadNotification,
);

notificationRouter.get('/me/notification-preferences', authenticate, getPreferences);
notificationRouter.put(
  '/me/notification-preferences',
  authenticate,
  csrfProtection,
  validate({ body: updatePreferencesSchema }),
  putPreferences,
);
