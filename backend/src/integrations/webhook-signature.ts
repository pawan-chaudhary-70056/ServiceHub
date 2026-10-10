import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Outbound webhook signing (`docs/32` §4).
 *
 * Every delivery is signed with a per-subscription secret over the **raw body** and a
 * timestamp, and a receiver verifies both. Signing the raw bytes — not a re-serialised
 * object — is deliberate: two `JSON.stringify` calls can differ in key order, so a receiver
 * that re-encodes before verifying would compute a different digest and reject valid calls.
 *
 * The header shape is Stripe-style and self-describing: `t=<unix-seconds>,v1=<hex>`. The
 * timestamp is inside the signed material, so it cannot be altered without invalidating the
 * signature; a receiver additionally rejects a timestamp outside the tolerance window,
 * which is the replay protection (`docs/32` §4).
 */

export const SIGNATURE_HEADER = 'X-ServiceHub-Signature';
export const TIMESTAMP_HEADER = 'X-ServiceHub-Timestamp';

/** `t=<seconds>,v1=<hex-hmac>` over `${timestamp}.${body}`. */
export function signWebhookPayload(secret: string, body: string, timestampMs: number): string {
  const timestamp = Math.floor(timestampMs / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Parses a signature header into its parts, or `null` when malformed. */
export function parseSignatureHeader(
  header: string,
): { timestamp: number; signature: string } | null {
  const parts = header.split(',');
  const timestampPart = parts.find((part) => part.startsWith('t='));
  const signaturePart = parts.find((part) => part.startsWith('v1='));
  if (!timestampPart || !signaturePart) return null;

  const timestamp = Number(timestampPart.slice(2));
  const signature = signaturePart.slice(3);
  if (!Number.isFinite(timestamp) || signature.length === 0) return null;

  return { timestamp, signature };
}

/**
 * Verifies a signature against a body and a clock, in constant time. Returns a reason string
 * on failure so the caller can record *why* it rejected the call without leaking the secret.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  options: { toleranceSeconds: number; nowMs: number },
): { valid: true } | { valid: false; reason: string } {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: 'Malformed signature header.' };

  const ageSeconds = Math.abs(options.nowMs / 1000 - parsed.timestamp);
  if (ageSeconds > options.toleranceSeconds) {
    return { valid: false, reason: 'Signature timestamp is outside the tolerance window.' };
  }

  const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.${body}`).digest('hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(parsed.signature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return { valid: false, reason: 'Signature mismatch.' };
  }
  return timingSafeEqual(expectedBuffer, providedBuffer)
    ? { valid: true }
    : { valid: false, reason: 'Signature mismatch.' };
}
