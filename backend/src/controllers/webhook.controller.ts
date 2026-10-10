import type { Request, Response } from 'express';
import {
  SUBSCRIBABLE_EVENTS,
  createWebhookSubscriptionForCaller,
  getIntegrationHealthForCaller,
  listDeadLettersForCaller,
  listWebhookSubscriptionsForCaller,
  retryDeadLetterForCaller,
  updateWebhookSubscriptionForCaller,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  CreateWebhookSubscriptionBody,
  UpdateWebhookSubscriptionBody,
} from '../validators/webhook.validators';
import { requestMeta } from './support';

/**
 * Webhook administration endpoints (docs/32 §12, docs/11 §9).
 *
 * The route carries the coarse `integration:*` permission and the service enforces it too;
 * the handler's job is translation only. Two facts the UI relies on:
 *
 *   - The signing **secret** is returned exactly once, on create; every other read exposes a
 *     hint (last four characters) so a credential can be matched but never recovered
 *     (`docs/32` §7).
 *   - All reads are tenant-scoped by the service, so a caller cannot enumerate another
 *     tenant's subscriptions or deliveries.
 */

/** `GET /admin/webhooks` — the tenant's subscriptions with a dead-letter count. */
export async function getWebhooks(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json({ subscriptions: await listWebhookSubscriptionsForCaller(req.actor) });
}

/** `POST /admin/webhooks` — creates a subscription; the secret is in this response only. */
export async function postWebhook(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<CreateWebhookSubscriptionBody>(res);
  const subscription = await createWebhookSubscriptionForCaller(body, req.actor, requestMeta(req));
  res.status(201).json({ subscription });
}

/** `PATCH /admin/webhooks/{id}` — edits or rotates the secret; both are audited. */
export async function patchWebhook(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<UpdateWebhookSubscriptionBody, { id: string }>(res);
  const subscription = await updateWebhookSubscriptionForCaller(
    params.id,
    body,
    req.actor,
    requestMeta(req),
  );
  res.status(200).json({ subscription });
}

/**
 * `GET /admin/integrations` — the health board (`docs/32` §12/§13).
 *
 * One uniform row per integration (outbound subscription or inbound endpoint) carrying its
 * last success, last error and dead-letter count, so an operator sees what is broken without
 * opening every integration.
 */
export async function getIntegrationHealthBoard(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json({ integrations: await getIntegrationHealthForCaller(req.actor) });
}

/**
 * `GET /admin/webhooks/events` — the event vocabulary a subscription may select (§4).
 *
 * Served from the single source of truth (`SUBSCRIBABLE_EVENTS`) so the admin UI cannot drift
 * from the event names the outbox actually emits.
 */
export async function getWebhookEvents(_req: Request, res: Response): Promise<void> {
  res.status(200).json({ events: SUBSCRIBABLE_EVENTS });
}

/** `GET /admin/integrations/dead-letters` — failed payloads, newest first (§13). */
export async function getDeadLetters(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { query } = validated<unknown, unknown, { limit: number }>(res);
  res.status(200).json(await listDeadLettersForCaller(req.actor, query.limit));
}

/** `POST /admin/integrations/dead-letters/{id}/retry` — requeues one delivery (§11, audited). */
export async function postRetryDeadLetter(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  const delivery = await retryDeadLetterForCaller(params.id, req.actor, requestMeta(req));
  res.status(200).json({ delivery });
}
