import type { Request, Response } from 'express';
import {
  createInboundEndpointForCaller,
  listInboundDeadLettersForCaller,
  listInboundEndpointsForCaller,
  receiveInboundWebhook,
  retryInboundDeadLetterForCaller,
  updateInboundEndpointForCaller,
} from '../services';
import { SIGNATURE_HEADER } from '../integrations/webhook-signature';
import { validated } from '../middlewares/validate';
import { MalformedRequestError, UnauthenticatedError } from '../utils/errors';
import type {
  CreateInboundEndpointBody,
  UpdateInboundEndpointBody,
} from '../validators/inbound-webhook.validators';
import { requestMeta } from './support';

/**
 * Inbound webhook endpoints (`docs/32` §5/§12).
 *
 * Two very different audiences share this file:
 *
 *   - the **admin** endpoints, which require `integration:manage`/`read` and a session;
 *   - `postInboundWebhook`, which is **public** — a provider has no session. Its
 *     authentication is the HMAC signature over the raw body, verified in the service, so it
 *     must never depend on `req.actor`.
 */

/** `GET /admin/inbound-endpoints` — the tenant's receivers, secret redacted. */
export async function getInboundEndpoints(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json({ endpoints: await listInboundEndpointsForCaller(req.actor) });
}

/** `POST /admin/inbound-endpoints` — registers a receiver; the secret is returned once. */
export async function postInboundEndpoint(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<CreateInboundEndpointBody>(res);
  const endpoint = await createInboundEndpointForCaller(body, req.actor, requestMeta(req));
  res.status(201).json({ endpoint });
}

/** `PATCH /admin/inbound-endpoints/{id}` — enable/disable or rotate the secret; audited. */
export async function patchInboundEndpoint(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<UpdateInboundEndpointBody, { id: string }>(res);
  const endpoint = await updateInboundEndpointForCaller(
    params.id,
    body,
    req.actor,
    requestMeta(req),
  );
  res.status(200).json({ endpoint });
}

/**
 * `POST /webhooks/inbound/{provider}` — public, signature-verified, idempotent
 * (`docs/32` §5/§12).
 *
 * There is **no session and no `req.actor`**: the signature is the authentication. The
 * handler verifies, persists the raw event, and acks with `202` — it never processes, so a
 * slow handler cannot cause a provider retry storm.
 */
export async function postInboundWebhook(req: Request, res: Response): Promise<void> {
  const { params } = validated<unknown, { provider: string }>(res);

  const rawBuffer = (req as { rawBody?: Buffer }).rawBody;
  if (!rawBuffer) {
    throw new MalformedRequestError('The webhook body must be sent as JSON.');
  }

  const outcome = await receiveInboundWebhook({
    key: params.provider,
    rawBody: rawBuffer.toString('utf8'),
    signature: req.header(SIGNATURE_HEADER.toLowerCase()) ?? undefined,
  });

  // A duplicate is acknowledged too — that is what stops the provider retrying.
  res.status(202).json({ accepted: outcome.accepted, duplicate: outcome.duplicate });
}

/** `GET /admin/integrations/inbound-dead-letters` — failed inbound events, newest first. */
export async function getInboundDeadLetters(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { query } = validated<unknown, unknown, { limit: number }>(res);
  res.status(200).json(await listInboundDeadLettersForCaller(req.actor, query.limit));
}

/** `POST /admin/integrations/inbound-dead-letters/{id}/retry` — requeues; audited. */
export async function postRetryInboundDeadLetter(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  const event = await retryInboundDeadLetterForCaller(params.id, req.actor, requestMeta(req));
  res.status(200).json({ event });
}
