import type { WebhookHttpClient, WebhookHttpRequest, WebhookHttpResult } from './index';

/**
 * The outbound webhook HTTP adapter (`docs/32` §3/§8).
 *
 * This is the only place a webhook is actually sent, and the only place HTTP statuses are
 * interpreted: the delivery worker reasons about "delivered" or "failed", never about a 502
 * (`docs/32` §3). It never throws — a transport failure is mapped to a domain-level result,
 * because a thrown exception out of an external call is how an integration failure reaches
 * the request path the specification forbids (`docs/32` §1, §9).
 *
 * Redirects are not followed: a subscription URL that redirects is a subscription
 * misconfiguration, and following it would send a signed payload somewhere the operator did
 * not authorise. TLS verification is never disabled (`docs/32` §7).
 */

/** 2xx is a delivery; a redirect or a 4xx/5xx is a failure the worker may retry. */
const DELIVERED_STATUS = 200;

function describeStatus(status: number): string {
  if (status >= 300 && status < 400) return `Subscriber redirected the delivery (HTTP ${status}).`;
  if (status >= 400 && status < 500) return `Subscriber rejected the delivery (HTTP ${status}).`;
  if (status >= 500) return `Subscriber failed to accept the delivery (HTTP ${status}).`;
  return `Subscriber returned an unexpected status (HTTP ${status}).`;
}

export const fetchWebhookClient: WebhookHttpClient = {
  async send(request: WebhookHttpRequest): Promise<WebhookHttpResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= DELIVERED_STATUS && response.status < 300) {
        return { delivered: true, status: response.status };
      }
      return {
        delivered: false,
        status: response.status,
        failureReason: describeStatus(response.status),
      };
    } catch (error) {
      const failureReason =
        error instanceof Error && error.name === 'AbortError'
          ? 'The subscriber did not respond within the timeout.'
          : 'The subscriber could not be reached.';
      return { delivered: false, failureReason };
    } finally {
      clearTimeout(timeout);
    }
  },
};

/** A recorded attempt, for tests that must assert on signing without a network (`docs/37`). */
export interface RecordedWebhookRequest extends WebhookHttpRequest {
  attempt: number;
}

/**
 * Builds a deterministic in-memory client: attempts are recorded, and the next result comes
 * from `script` (the last entry repeats). Tests drive the retry/dead-letter path by feeding a
 * short script of failures, then inspect the signed headers of what was attempted.
 */
export function createRecordingWebhookClient(
  script: readonly WebhookHttpResult[] = [{ delivered: true, status: 200 }],
): { client: WebhookHttpClient; requests: RecordedWebhookRequest[] } {
  const requests: RecordedWebhookRequest[] = [];
  const client: WebhookHttpClient = {
    async send(request: WebhookHttpRequest): Promise<WebhookHttpResult> {
      requests.push({ ...request, attempt: requests.length + 1 });
      const index = Math.min(requests.length - 1, script.length - 1);
      return script[index] ?? { delivered: true, status: 200 };
    },
  };
  return { client, requests };
}
