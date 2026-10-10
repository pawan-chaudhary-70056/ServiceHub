import { assertPermission, type Principal } from '../helpers/authorization';
import { NotFoundError } from '../utils/errors';
import {
  inboundHealthByEndpoint,
  listInboundEndpoints,
  listWebhookSubscriptions,
  webhookHealthBySubscription,
  type InboundHealthRow,
  type WebhookHealthRow,
} from '../models';

/**
 * The integration health board (`docs/32` §12 `GET /admin/integrations`, `§13`).
 *
 * "Status, last success, last error" per integration, plus the dead-letter count. The shape is
 * deliberately uniform across kinds — an operator watching the board should not have to learn
 * two vocabularies — so outbound subscriptions and inbound endpoints are projected into the
 * same `IntegrationHealth`.
 *
 * `healthy` is derived, not stored: an integration is unhealthy once it has a dead-lettered
 * failure, or a failure more recent than its last success. Deriving it means the board can
 * never disagree with the underlying rows.
 */

export type IntegrationKind = 'OUTBOUND_WEBHOOK' | 'INBOUND_WEBHOOK';

export interface IntegrationHealth {
  id: string;
  kind: IntegrationKind;
  /** A human label: the subscription's description, or the endpoint's provider. */
  name: string;
  /** The distinguishing detail: the subscription URL, or the endpoint key. */
  detail: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /** Successful deliveries (outbound) or processed events (inbound). */
  succeeded: number;
  /** Failures including dead-lettered ones. */
  failed: number;
  deadLettered: number;
  /** `failed / (succeeded + failed)`, or `null` when nothing has been attempted. */
  errorRate: number | null;
  healthy: boolean;
}

function summarize(
  succeeded: number,
  failed: number,
  deadLettered: number,
  lastSuccessAt: Date | null,
  lastErrorAt: Date | null,
): Pick<IntegrationHealth, 'errorRate' | 'healthy'> {
  const total = succeeded + failed;
  const errorRate = total > 0 ? failed / total : null;
  const failedSinceSuccess =
    lastErrorAt !== null && (lastSuccessAt === null || lastErrorAt >= lastSuccessAt);
  return { errorRate, healthy: deadLettered === 0 && !failedSinceSuccess };
}

function fromWebhook(
  subscription: { id: string; description: string; url: string; enabled: boolean },
  health: WebhookHealthRow | undefined,
): IntegrationHealth {
  const succeeded = health?.delivered ?? 0;
  const failed = health?.failed ?? 0;
  const deadLettered = health?.deadLettered ?? 0;
  const lastSuccessAt = health?.lastSuccessAt ?? null;
  const lastErrorAt = health?.lastErrorAt ?? null;
  return {
    id: subscription.id,
    kind: 'OUTBOUND_WEBHOOK',
    name: subscription.description,
    detail: subscription.url,
    enabled: subscription.enabled,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: lastErrorAt?.toISOString() ?? null,
    lastError: health?.lastError ?? null,
    succeeded,
    failed,
    deadLettered,
    ...summarize(succeeded, failed, deadLettered, lastSuccessAt, lastErrorAt),
  };
}

function fromInbound(
  endpoint: { id: string; provider: string; key: string; enabled: boolean },
  health: InboundHealthRow | undefined,
): IntegrationHealth {
  const succeeded = health?.processed ?? 0;
  const failed = health?.failed ?? 0;
  const deadLettered = health?.deadLettered ?? 0;
  const lastSuccessAt = health?.lastSuccessAt ?? null;
  const lastErrorAt = health?.lastErrorAt ?? null;
  return {
    id: endpoint.id,
    kind: 'INBOUND_WEBHOOK',
    name: endpoint.provider,
    detail: endpoint.key,
    enabled: endpoint.enabled,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: lastErrorAt?.toISOString() ?? null,
    lastError: health?.lastError ?? null,
    succeeded,
    failed,
    deadLettered,
    ...summarize(succeeded, failed, deadLettered, lastSuccessAt, lastErrorAt),
  };
}

/** The tenant's integrations and their health, unhealthy ones surfaced first. */
export async function getIntegrationHealthForCaller(
  actor: Principal,
): Promise<IntegrationHealth[]> {
  assertPermission(actor, 'integration:read');
  if (!actor.organizationId) {
    throw new NotFoundError('Integrations are tenant-scoped.');
  }
  const organizationId = actor.organizationId;

  const [subscriptions, webhookHealth, endpoints, inboundHealth] = await Promise.all([
    listWebhookSubscriptions(organizationId),
    webhookHealthBySubscription(organizationId),
    listInboundEndpoints(organizationId),
    inboundHealthByEndpoint(organizationId),
  ]);

  const webhookBySub = new Map(webhookHealth.map((row) => [row.subscriptionId, row]));
  const inboundByEndpoint = new Map(inboundHealth.map((row) => [row.endpointId, row]));

  const health: IntegrationHealth[] = [
    ...subscriptions.map((subscription) =>
      fromWebhook(subscription, webhookBySub.get(subscription.id)),
    ),
    ...endpoints.map((endpoint) => fromInbound(endpoint, inboundByEndpoint.get(endpoint.id))),
  ];

  // Unhealthy first, then by most recent activity — a board's job is to show what needs
  // attention without the operator scanning every row.
  return health.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? 1 : -1;
    const activity = (row: IntegrationHealth): number =>
      Number(new Date(row.lastErrorAt ?? row.lastSuccessAt ?? 0));
    return activity(b) - activity(a);
  });
}
