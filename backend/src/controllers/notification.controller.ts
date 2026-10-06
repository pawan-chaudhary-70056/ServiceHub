import type { Request, Response } from 'express';
import {
  listMyNotifications,
  listMyPreferences,
  readAllNotifications,
  readNotification,
  updateMyPreferences,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  NotificationListQuery,
  UpdatePreferencesInput,
} from '../validators/notification.validators';

/**
 * Notification centre and preference endpoints (`docs/29` §12, docs/11 §9).
 *
 * All self-scoped: the actor id is the only subject, so there is no route-level permission
 * beyond authentication. A notification the caller does not own is a `404`.
 */

/** `GET /me/notification-preferences` — the caller's effective preferences. */
export async function getPreferences(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listMyPreferences(req.actor.userId);
  res.status(200).json({ items });
}

/** `PUT /me/notification-preferences` — applies overrides (mandatory events refused). */
export async function putPreferences(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<UpdatePreferencesInput>(res);
  const items = await updateMyPreferences(req.actor.userId, body);
  res.status(200).json({ items });
}

/** `GET /notifications` — the caller's in-app notifications. */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<unknown, unknown, NotificationListQuery>(res);
  const page = await listMyNotifications(req.actor.userId, {
    unreadOnly: query.unreadOnly,
    limit: query.limit,
    cursor: query.cursor,
  });
  res.status(200).json(page);
}

/** `POST /notifications/{id}/read` — marks one read (idempotent). */
export async function postReadNotification(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const notification = await readNotification(req.actor.userId, params.id);
  res.status(200).json({ notification });
}

/** `POST /notifications/read-all` — marks every unread notification read. */
export async function postReadAllNotifications(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const result = await readAllNotifications(req.actor.userId);
  res.status(200).json(result);
}
