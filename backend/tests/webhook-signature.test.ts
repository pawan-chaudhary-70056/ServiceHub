import { describe, expect, it } from 'vitest';
import {
  parseSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../src/integrations/webhook-signature';

/**
 * Webhook signing (`docs/32` §4). These are the properties a receiver depends on: a valid
 * signature verifies, any change to the body or the timestamp invalidates it, and a stale
 * timestamp is rejected even when the signature is genuine (replay protection).
 */

const SECRET = 'whsec_test_secret_value_0123456789';
const BODY = JSON.stringify({ id: 'evt_1', type: 'notification.request.created' });
const NOW_MS = 1_700_000_000_000;

describe('webhook signature', () => {
  it('verifies a signature over the raw body', () => {
    const header = signWebhookPayload(SECRET, BODY, NOW_MS);
    const result = verifyWebhookSignature(SECRET, BODY, header, {
      toleranceSeconds: 300,
      nowMs: NOW_MS,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a body that was changed after signing', () => {
    const header = signWebhookPayload(SECRET, BODY, NOW_MS);
    const result = verifyWebhookSignature(SECRET, `${BODY} `, header, {
      toleranceSeconds: 300,
      nowMs: NOW_MS,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const header = signWebhookPayload('a-different-secret', BODY, NOW_MS);
    const result = verifyWebhookSignature(SECRET, BODY, header, {
      toleranceSeconds: 300,
      nowMs: NOW_MS,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a genuine signature outside the tolerance window (replay protection)', () => {
    const header = signWebhookPayload(SECRET, BODY, NOW_MS);
    const result = verifyWebhookSignature(SECRET, BODY, header, {
      toleranceSeconds: 300,
      nowMs: NOW_MS + 10 * 60 * 1000,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/tolerance window/);
  });

  it('rejects a malformed header', () => {
    const result = verifyWebhookSignature(SECRET, BODY, 'not-a-signature', {
      toleranceSeconds: 300,
      nowMs: NOW_MS,
    });
    expect(result.valid).toBe(false);
    expect(parseSignatureHeader('not-a-signature')).toBeNull();
  });
});
