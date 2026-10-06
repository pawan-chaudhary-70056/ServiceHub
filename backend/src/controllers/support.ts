import type { Request } from 'express';
import { isProduction } from '../config';
import type { RequestMeta } from '../services';

/**
 * Controller-layer helpers (docs/03 §3).
 *
 * Controllers translate between HTTP and the service layer. Extracting the request
 * metadata for the audit trail is exactly such a translation, and keeping it in one
 * place means every mutation records the same correlation id, source address and agent
 * (docs/31).
 */

export function requestMeta(req: Request): RequestMeta {
  return {
    correlationId: req.correlationId ?? 'unknown',
    sourceIp: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

/**
 * Whether a fresh invitation/reset token may be returned in an API response.
 *
 * In production the token travels only in the queued email (`docs/29 §3`), because
 * returning it in the body would let anyone who can call the endpoint mint a working
 * onboarding link. Outside production it is returned so a developer can complete the
 * flow without a mail server — an explicit, environment-gated convenience, not a
 * production behaviour.
 */
export function mayDiscloseToken(): boolean {
  return !isProduction;
}
