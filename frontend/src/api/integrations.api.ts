import { apiRequest } from './client';

/**
 * Integration administration API (docs/32 §4/§5/§12, docs/11 §9).
 *
 * Two facts the UI must respect and never re-derive:
 *
 *   - A **signing/verification secret is returned once**, in the create response. Every other
 *     read gives a `secretHint` (the last four characters), so a receiver can be matched but a
 *     credential can never be recovered from the API.
 *   - Dead-letter listing is server-scoped and server-totaled; the UI renders what it is
 *     given and never assumes it can see every failure.
 */

export type WebhookDeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD_LETTER';

export interface WebhookSubscription {
  id: string;
  description: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  secretHint: string;
  deadLetterCount: number;
  /** Present only on the create response. */
  secret?: string;
}

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export type InboundWebhookStatus =
  'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER';

export interface InboundEndpoint {
  id: string;
  key: string;
  provider: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  secretHint: string;
  deadLetterCount: number;
  /** Present only on the create response. */
  secret?: string;
  /** Present only on the create response: the path a provider posts to. */
  path?: string;
}

export interface InboundEvent {
  id: string;
  endpointId: string;
  providerEventId: string;
  eventType: string | null;
  status: InboundWebhookStatus;
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
  expiresAt: string;
}

export type IntegrationKind = 'OUTBOUND_WEBHOOK' | 'INBOUND_WEBHOOK';

/** One row of the health board (`32` §12/§13). `healthy` is derived by the server. */
export interface IntegrationHealth {
  id: string;
  kind: IntegrationKind;
  name: string;
  detail: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  succeeded: number;
  failed: number;
  deadLettered: number;
  errorRate: number | null;
  healthy: boolean;
}

/** `GET /admin/integrations` — last success, last error and dead-letter counts per integration. */
export function getIntegrationHealth(
  signal?: AbortSignal,
): Promise<{ integrations: IntegrationHealth[] }> {
  return apiRequest<{ integrations: IntegrationHealth[] }>('/admin/integrations', { signal });
}

/** The event vocabulary a subscription may select (`32` §4), served by the backend. */
export function listWebhookEvents(signal?: AbortSignal): Promise<{ events: string[] }> {
  return apiRequest<{ events: string[] }>('/admin/webhooks/events', { signal });
}

export function listWebhookSubscriptions(
  signal?: AbortSignal,
): Promise<{ subscriptions: WebhookSubscription[] }> {
  return apiRequest<{ subscriptions: WebhookSubscription[] }>('/admin/webhooks', { signal });
}

export interface CreateWebhookSubscriptionInput {
  description: string;
  url: string;
  events: string[];
}

export function createWebhookSubscription(
  input: CreateWebhookSubscriptionInput,
): Promise<{ subscription: WebhookSubscription }> {
  return apiRequest<{ subscription: WebhookSubscription }>('/admin/webhooks', {
    method: 'POST',
    body: input,
  });
}

export interface UpdateWebhookSubscriptionInput {
  description?: string;
  url?: string;
  events?: string[];
  enabled?: boolean;
  rotateSecret?: boolean;
}

export function updateWebhookSubscription(
  id: string,
  input: UpdateWebhookSubscriptionInput,
): Promise<{ subscription: WebhookSubscription }> {
  return apiRequest<{ subscription: WebhookSubscription }>(`/admin/webhooks/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function listInboundEndpoints(
  signal?: AbortSignal,
): Promise<{ endpoints: InboundEndpoint[] }> {
  return apiRequest<{ endpoints: InboundEndpoint[] }>('/admin/inbound-endpoints', { signal });
}

export function createInboundEndpoint(input: {
  key: string;
  provider: string;
}): Promise<{ endpoint: InboundEndpoint }> {
  return apiRequest<{ endpoint: InboundEndpoint }>('/admin/inbound-endpoints', {
    method: 'POST',
    body: input,
  });
}

export function updateInboundEndpoint(
  id: string,
  input: { provider?: string; enabled?: boolean; rotateSecret?: boolean },
): Promise<{ endpoint: InboundEndpoint }> {
  return apiRequest<{ endpoint: InboundEndpoint }>(`/admin/inbound-endpoints/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function listOutboundDeadLetters(
  signal?: AbortSignal,
): Promise<{ deliveries: WebhookDelivery[]; total: number }> {
  return apiRequest<{ deliveries: WebhookDelivery[]; total: number }>(
    '/admin/integrations/dead-letters',
    { signal },
  );
}

export function retryOutboundDeadLetter(id: string): Promise<{ delivery: WebhookDelivery }> {
  return apiRequest<{ delivery: WebhookDelivery }>(`/admin/integrations/dead-letters/${id}/retry`, {
    method: 'POST',
  });
}

export function listInboundDeadLetters(
  signal?: AbortSignal,
): Promise<{ deliveries: InboundEvent[]; total: number }> {
  return apiRequest<{ deliveries: InboundEvent[]; total: number }>(
    '/admin/integrations/inbound-dead-letters',
    { signal },
  );
}

export function retryInboundDeadLetter(id: string): Promise<{ event: InboundEvent }> {
  return apiRequest<{ event: InboundEvent }>(
    `/admin/integrations/inbound-dead-letters/${id}/retry`,
    { method: 'POST' },
  );
}

/**
 * Integration configuration (`docs/32` §11/§12/§13).
 *
 * `credentialRef` is a **reference** (`env:NAME`), never a secret — the API rejects anything
 * that looks like a value, so the UI must collect a location, not a credential.
 */
export interface IntegrationReliabilityConfig {
  breakerFailureThreshold: number;
  breakerOpenMs: number;
  breakerHalfOpenSuccesses: number;
  bulkheadMaxConcurrent: number;
  bulkheadMaxQueue: number;
  bulkheadQueueTimeoutMs: number;
  retryMaxAttempts: number;
  timeoutMs: number;
}

export interface IntegrationConfig {
  key: string;
  name: string;
  description: string;
  direction: 'outbound' | 'inbound' | 'both';
  testable: boolean;
  usesCredential: boolean;
  enabled: boolean;
  config: IntegrationReliabilityConfig;
  defaults: IntegrationReliabilityConfig;
  credentialRef: string | null;
  credentialConfigured: boolean;
  credentialRefExample: string;
  lastTestedAt: string | null;
  lastTestStatus: 'OK' | 'FAILED' | null;
  lastTestError: string | null;
  updatedAt: string | null;
}

export interface IntegrationTestResult {
  key: string;
  status: 'OK' | 'FAILED' | 'SKIPPED';
  message: string;
  checkedAt: string;
}

export function listIntegrationConfig(
  signal?: AbortSignal,
): Promise<{ integrations: IntegrationConfig[] }> {
  return apiRequest<{ integrations: IntegrationConfig[] }>('/admin/integrations/config', {
    signal,
  });
}

export function updateIntegrationConfig(
  key: string,
  input: {
    enabled?: boolean;
    config?: Partial<IntegrationReliabilityConfig>;
    credentialRef?: string | null;
  },
): Promise<{ integration: IntegrationConfig }> {
  return apiRequest<{ integration: IntegrationConfig }>(`/admin/integrations/config/${key}`, {
    method: 'PATCH',
    body: input,
  });
}

export function testIntegrationConfig(key: string): Promise<{ result: IntegrationTestResult }> {
  return apiRequest<{ result: IntegrationTestResult }>(`/admin/integrations/config/${key}/test`, {
    method: 'POST',
  });
}
