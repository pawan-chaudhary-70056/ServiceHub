/**
 * Integration adapters (docs/32-INTEGRATIONS.md).
 *
 * The governing principle: an integration failure must never corrupt the core domain
 * or the request path. Three rules follow, and they are the reason this folder exists
 * as a boundary rather than vendors being called from services:
 *
 *   1. External calls never happen inside a request transaction (docs/33 §11).
 *   2. Vendor types never appear in domain services — only in adapters. This file
 *      defines the interfaces the DOMAIN owns; an adapter implements them.
 *   3. Removing a vendor touches exactly one file plus its fake.
 *
 * Every outbound call must set an explicit timeout, retry only idempotent operations
 * with bounded exponential backoff and jitter, and run behind a circuit breaker
 * (docs/03 §8, docs/32 §8).
 */

/** Result of a delivery attempt, mapped from the vendor's errors into domain terms. */
export interface DeliveryResult {
  accepted: boolean;
  /** Vendor-side identifier, stored for delivery-webhook correlation. */
  providerMessageId?: string;
  /** Domain-level reason, safe to log. Never the raw vendor response body. */
  failureReason?: string;
}

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  /** Server-rendered, escaped HTML (docs/17). */
  html: string;
  /** Plain-text alternative — every HTML email must have one (docs/29 §8). */
  text: string;
}

/** Email provider contract. Provider selected by `ADR-0006` (SendGrid via Knock). */
export interface EmailAdapter {
  send(message: EmailMessage): Promise<DeliveryResult>;
}

/** SMS is deliberately narrow: critical events only (docs/29 §6). */
export interface SmsAdapter {
  send(to: string, body: string): Promise<DeliveryResult>;
}

/** Outbound webhook subscription target (docs/32 §4). */
export interface WebhookTarget {
  id: string;
  url: string;
  /** Per-subscription HMAC secret used to sign the raw body. */
  secret: string;
  events: readonly string[];
}

/**
 * Process-local fakes used until a provider is selected.
 *
 * They return a failure instead of sending, so the domain and its tests can be
 * exercised without a network dependency (docs/37 §3). They are NOT production
 * adapters and must be replaced by a real adapter before the notifications slice ships
 * (`ADR-0006`).
 */
export const unsupportedEmailAdapter: EmailAdapter = {
  async send(): Promise<DeliveryResult> {
    return {
      accepted: false,
      failureReason: 'Email provider adapter not yet wired (ADR-0006).',
    };
  },
};

export const unsupportedSmsAdapter: SmsAdapter = {
  async send(): Promise<DeliveryResult> {
    return {
      accepted: false,
      failureReason: 'SMS provider adapter not yet wired (ADR-0006).',
    };
  },
};
