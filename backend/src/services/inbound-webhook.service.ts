import type { InboundWebhookEndpoint, InboundWebhookEvent, Prisma } from '@prisma/client';
import { config } from '../config';
import { assertPermission, type Principal } from '../helpers/authorization';
import { randomToken, sha256 } from '../helpers/crypto';
import { verifyWebhookSignature } from '../integrations/webhook-signature';
import {
  MalformedRequestError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../utils/errors';
import { logger } from '../utils/logger';
import {
  countDeadLetterInboundEvents,
  createInboundEndpoint,
  findInboundEndpointById,
  findInboundEndpointByKey,
  findInboundEventById,
  listDeadLetterInboundEvents,
  listDueInboundEvents,
  listInboundEndpoints,
  markInboundProcessed,
  purgeExpiredInboundPayloads,
  recordInboundEvent,
  recordInboundFailure,
  requeueInboundEvent,
  updateInboundEndpoint,
  writeAudit,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Inbound webhooks — docs/32 §5.
 *
 * The order is deliberate and is the whole point of the design:
 *
 *   1. **Verify** — signature and timestamp, or reject (`§5`, AC2 of `§15`).
 *   2. **Persist** the raw event — so nothing is lost if processing is slow or fails.
 *   3. **Ack** — before processing, so a slow handler cannot make the provider retry and
 *      amplify load.
 *   4. **Process** in a worker, where a failure retries and then dead-letters.
 *
 * The trust rule from `§18` applies throughout: **inbound payloads are untrusted input**.
 * The signature proves origin and integrity, never schema — the worker validates with the
 * same rigour as user input.
 */

/**
 * The ack payload of a received delivery. A signature or replay failure never reaches here —
 * it throws `UnauthenticatedError`, which is mapped to `401` so a prober cannot distinguish a
 * valid key with a bad signature from an unknown one (`docs/32` §5).
 */
export interface ReceiveOutcome {
  /** Always true on return; the `false` case is an exception, not a value. */
  accepted: true;
  duplicate: boolean;
  eventId: string;
  providerEventId: string;
}

export interface InboundEndpointView {
  id: string;
  key: string;
  provider: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  secretHint: string;
  deadLetterCount: number;
}

export interface InboundEndpointCreated extends InboundEndpointView {
  secret: string;
  /** The path a provider posts to; the key is opaque to the caller. */
  path: string;
}

export interface InboundEventView {
  id: string;
  endpointId: string;
  providerEventId: string;
  eventType: string | null;
  status: InboundWebhookEvent['status'];
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
  expiresAt: string;
}

/**
 * Registered handlers, keyed by `eventType`. A provider event with no handler is still
 * **accepted and recorded** — it is not an error for the platform to receive an event type
 * it does not act on — so an empty registry means "recording only", not "failing".
 */
export type InboundHandler = (event: {
  id: string;
  organizationId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}) => Promise<void>;

const HANDLERS = new Map<string, InboundHandler>();

export function registerInboundHandler(eventType: string, handler: InboundHandler): void {
  HANDLERS.set(eventType, handler);
}

/** Test seam: clears the registry so a test's handler does not leak into another. */
export function clearInboundHandlers(): void {
  HANDLERS.clear();
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new NotFoundError('Inbound endpoints are tenant-scoped.');
  }
  return actor.organizationId;
}

function secretHint(secret: string): string {
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}

function toEndpointView(row: InboundWebhookEndpoint, deadLetterCount: number): InboundEndpointView {
  return {
    id: row.id,
    key: row.key,
    provider: row.provider,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    secretHint: secretHint(row.secret),
    deadLetterCount,
  };
}

export function toInboundEventView(row: InboundWebhookEvent): InboundEventView {
  return {
    id: row.id,
    endpointId: row.endpointId,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** The `{provider}` path segment: a URL-safe slug, so it cannot inject path segments. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export interface CreateInboundEndpointInput {
  key: string;
  provider: string;
}

export async function createInboundEndpointForCaller(
  input: CreateInboundEndpointInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<InboundEndpointCreated> {
  assertPermission(actor, 'integration:manage');
  const organizationId = requireTenant(actor);

  if (!KEY_PATTERN.test(input.key)) {
    throw new ValidationError([
      {
        field: 'key',
        message: 'The endpoint key must be lowercase alphanumeric with hyphens.',
      },
    ]);
  }
  if (await findInboundEndpointByKey(input.key)) {
    throw new ValidationError([{ field: 'key', message: 'That endpoint key is already in use.' }]);
  }

  const secret = randomToken(32);
  const created = await createInboundEndpoint({
    key: input.key,
    provider: input.provider,
    organizationId,
    secret,
    createdById: actor.userId,
  });

  // The audited snapshot omits the secret (docs/32 §7).
  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_INBOUND_ENDPOINT_CREATE,
    entityType: AUDIT_ENTITY.INBOUND_WEBHOOK_ENDPOINT,
    entityId: created.id,
    after: { key: created.key, provider: created.provider },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });

  return {
    ...toEndpointView(created, 0),
    secret,
    path: `/api/v1/webhooks/inbound/${created.key}`,
  };
}

export async function listInboundEndpointsForCaller(
  actor: Principal,
): Promise<InboundEndpointView[]> {
  assertPermission(actor, 'integration:read');
  const organizationId = requireTenant(actor);
  const rows = await listInboundEndpoints(organizationId);
  const deadLetterCount = await countDeadLetterInboundEvents(organizationId);
  return rows.map((row) => toEndpointView(row, deadLetterCount));
}

export interface UpdateInboundEndpointInput {
  enabled?: boolean;
  rotateSecret?: boolean;
  provider?: string;
}

export async function updateInboundEndpointForCaller(
  id: string,
  input: UpdateInboundEndpointInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<InboundEndpointView> {
  assertPermission(actor, 'integration:manage');
  const organizationId = requireTenant(actor);

  const existing = await findInboundEndpointById(id);
  if (!existing || existing.organizationId !== organizationId) {
    throw new NotFoundError('Inbound endpoint not found.');
  }

  const secret = input.rotateSecret ? randomToken(32) : undefined;
  const updated = await updateInboundEndpoint(id, {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(secret ? { secret } : {}),
  });

  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_INBOUND_ENDPOINT_UPDATE,
    entityType: AUDIT_ENTITY.INBOUND_WEBHOOK_ENDPOINT,
    entityId: id,
    before: { provider: existing.provider, enabled: existing.enabled },
    after: {
      provider: updated.provider,
      enabled: updated.enabled,
      ...(secret ? { secretRotated: true } : {}),
    },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });

  return toEndpointView(updated, await countDeadLetterInboundEvents(organizationId));
}

/** A received body is only ever treated as this much; the worker validates its shape. */
function extractPayload(rawBody: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new MalformedRequestError('The webhook body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedRequestError('The webhook body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The synchronous receive path (`docs/32` §5): verify, persist, ack. It returns the ack
 * payload and never processes. A duplicate delivery is a **no-op** that still acks, so the
 * provider stops retrying.
 */
export async function receiveInboundWebhook(params: {
  key: string;
  rawBody: string;
  signature: string | undefined;
  now?: Date;
}): Promise<ReceiveOutcome> {
  const now = params.now ?? new Date();

  const endpoint = await findInboundEndpointByKey(params.key);
  // An unknown key and a bad signature are both `401`, so the endpoint cannot be probed by
  // comparing status codes (docs/32 §5, docs/17).
  if (!endpoint || !endpoint.enabled) {
    throw new UnauthenticatedError('The inbound webhook could not be authenticated.');
  }
  if (!params.signature) {
    throw new UnauthenticatedError('The inbound webhook could not be authenticated.');
  }

  const verification = verifyWebhookSignature(endpoint.secret, params.rawBody, params.signature, {
    toleranceSeconds: config.INBOUND_WEBHOOK_TOLERANCE_SECONDS,
    nowMs: now.getTime(),
  });
  if (!verification.valid) {
    // The reason is logged for an operator but never returned to the caller.
    logger.warn(
      { endpointKey: endpoint.key, reason: verification.reason },
      'Inbound webhook rejected',
    );
    throw new UnauthenticatedError('The inbound webhook could not be authenticated.');
  }

  const payload = extractPayload(params.rawBody);
  const declaredId = payload.id ?? payload.event_id;
  // A provider that sends no id still gets idempotency: the body digest is stable across
  // retries, so a redelivered identical payload dedupes on it.
  const providerEventId =
    typeof declaredId === 'string' && declaredId.length > 0 ? declaredId : sha256(params.rawBody);
  const eventType = typeof payload.type === 'string' ? payload.type : null;

  const expiresAt = new Date(
    now.getTime() + config.INBOUND_WEBHOOK_PAYLOAD_TTL_HOURS * 60 * 60 * 1000,
  );
  const { event, created } = await recordInboundEvent({
    endpointId: endpoint.id,
    organizationId: endpoint.organizationId,
    providerEventId,
    eventType,
    rawPayload: payload as Prisma.InputJsonValue,
    expiresAt,
  });

  return { accepted: true, duplicate: !created, eventId: event.id, providerEventId };
}

function backoffMs(attempts: number, jitter: () => number): number {
  const base = config.INBOUND_WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(base, 60 * 60_000);
  return Math.floor(capped * (0.5 + 0.5 * jitter()));
}

export interface InboundProcessResult {
  scanned: number;
  processed: number;
  failed: number;
  deadLettered: number;
  unhandled: number;
  purgedPayloads: number;
}

/**
 * The inbound processing worker (`docs/32` §5). It validates and dispatches through the
 * handler registry, retries a failing handler with bounded backoff, and dead-letters at the
 * cap. It never throws: an integration failure must not reach the request path or the rest of
 * the system (`§1`, `§9`).
 */
export async function processInboundWebhookEvents(
  options: { now?: Date; limit?: number; jitter?: () => number } = {},
): Promise<InboundProcessResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? config.INBOUND_WEBHOOK_BATCH_SIZE;
  const jitter = options.jitter ?? Math.random;

  const result: InboundProcessResult = {
    scanned: 0,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    unhandled: 0,
    purgedPayloads: await purgeExpiredInboundPayloads(now),
  };

  const events = await listDueInboundEvents(now, limit);
  for (const event of events) {
    result.scanned += 1;

    const handler = event.eventType ? HANDLERS.get(event.eventType) : undefined;
    if (!handler) {
      // Accepted and recorded, but nothing acts on it (yet). Not a failure.
      await markInboundProcessed(event.id, now);
      result.unhandled += 1;
      continue;
    }

    const payload = (event.rawPayload ?? {}) as Record<string, unknown>;
    try {
      await handler({
        id: event.id,
        organizationId: event.organizationId,
        eventType: event.eventType as string,
        payload,
      });
      await markInboundProcessed(event.id, now);
      result.processed += 1;
    } catch (error) {
      const attempts = event.attempts + 1;
      const reason = error instanceof Error ? error.message : 'Inbound processing failed.';
      if (attempts >= config.INBOUND_WEBHOOK_MAX_ATTEMPTS) {
        await recordInboundFailure(event.id, { attempts, error: reason, nextAttemptAt: null });
        logger.error(
          { inboundEventId: event.id, eventType: event.eventType, attempts },
          'Inbound webhook dead-lettered after exhausting retries',
        );
        result.deadLettered += 1;
        continue;
      }
      await recordInboundFailure(event.id, {
        attempts,
        error: reason,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, jitter)),
      });
      result.failed += 1;
    }
  }

  return result;
}

export async function listInboundDeadLettersForCaller(
  actor: Principal,
  limit = 50,
): Promise<{ deliveries: InboundEventView[]; total: number }> {
  assertPermission(actor, 'integration:read');
  const organizationId = requireTenant(actor);
  const rows = await listDeadLetterInboundEvents(organizationId, limit);
  return {
    deliveries: rows.map(toInboundEventView),
    total: await countDeadLetterInboundEvents(organizationId),
  };
}

export async function retryInboundDeadLetterForCaller(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<InboundEventView> {
  assertPermission(actor, 'integration:retry');
  const organizationId = requireTenant(actor);

  const existing = await findInboundEventById(id);
  if (
    !existing ||
    existing.organizationId !== organizationId ||
    existing.status !== 'DEAD_LETTER'
  ) {
    throw new NotFoundError('Dead-lettered inbound event not found.');
  }

  const requeued = await requeueInboundEvent(id);
  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_INBOUND_RETRY,
    entityType: AUDIT_ENTITY.INBOUND_WEBHOOK_ENDPOINT,
    entityId: requeued.endpointId,
    after: { inboundEventId: id, providerEventId: requeued.providerEventId },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });
  return toInboundEventView(requeued);
}
