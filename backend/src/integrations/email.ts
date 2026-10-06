import { randomUUID } from 'node:crypto';
import { config, isProduction } from '../config';
import { logger } from '../utils/logger';
import {
  unsupportedEmailAdapter,
  type DeliveryResult,
  type EmailAdapter,
  type EmailMessage,
} from './index';

/**
 * Email adapters (`ADR-0006`, docs/29 §3, §6, docs/32).
 *
 * The domain owns the `EmailAdapter` interface (`integrations/index.ts`); this file is the
 * only place a vendor is named. Three implementations:
 *
 *   - **SendGrid** — the provider chosen by `ADR-0006`. Uses the Web API (`fetch`, no
 *     extra dependency) and is selected when `SENDGRID_API_KEY` is configured.
 *   - **Logging** — development only. Records the send and returns a synthetic provider
 *     id so the whole pipeline (outbox → template → adapter → `Notification`) is
 *     exercised locally without a network dependency.
 *   - **Unsupported** — returned in production when no provider is configured. It fails
 *     the send rather than silently pretending success; config validation makes this
 *     unreachable in a correctly-booted production process.
 *
 * A provider failure never throws out of the adapter: it is mapped to a `DeliveryResult`
 * the worker turns into a retry or a dead-letter (`docs/29` §10).
 */

/** Outbound calls must have an explicit timeout (`docs/32` §8). */
const SENDGRID_TIMEOUT_MS = 10_000;

/** Accepts `addr@host` or `Display Name <addr@host>` and returns the bare address. */
function fromAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

function createSendGridAdapter(apiKey: string, from: string): EmailAdapter {
  const sender = fromAddress(from);
  return {
    async send(message: EmailMessage): Promise<DeliveryResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SENDGRID_TIMEOUT_MS);
      try {
        const response = await fetch(`${config.SENDGRID_API_BASE_URL}/v3/mail/send`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: message.to }] }],
            from: { email: sender },
            subject: message.subject,
            content: [
              { type: 'text/plain', value: message.text },
              { type: 'text/html', value: message.html },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // Never surface the raw vendor body (it may echo PII). A status code is enough
          // to classify the failure for retry/alerting.
          return {
            accepted: false,
            failureReason: `SendGrid rejected the message (HTTP ${response.status}).`,
          };
        }

        const providerMessageId = response.headers.get('x-message-id') ?? undefined;
        return providerMessageId ? { accepted: true, providerMessageId } : { accepted: true };
      } catch (error) {
        const reason =
          error instanceof Error && error.name === 'AbortError'
            ? 'SendGrid request timed out.'
            : 'SendGrid request failed.';
        return { accepted: false, failureReason: reason };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function createLoggingAdapter(): EmailAdapter {
  return {
    async send(message: EmailMessage): Promise<DeliveryResult> {
      logger.info(
        { to: message.to, subject: message.subject },
        'Email not sent: no provider configured; logging in development',
      );
      return { accepted: true, providerMessageId: `dev-log:${randomUUID()}` };
    },
  };
}

/** The process-wide adapter, resolved once from configuration. */
export function createEmailAdapter(): EmailAdapter {
  if (config.SENDGRID_API_KEY) {
    return createSendGridAdapter(
      config.SENDGRID_API_KEY,
      config.EMAIL_FROM ?? 'no-reply@servicehub.local',
    );
  }
  if (isProduction) {
    return unsupportedEmailAdapter;
  }
  return createLoggingAdapter();
}

export const emailAdapter: EmailAdapter = createEmailAdapter();
