import type { ProblemCode, ProblemDetail } from '../utils/errors';

/**
 * The single error response shape for the whole API (docs/11-API-CONTRACT.md §4).
 *
 * The shape is RFC 7807 `application/problem+json`, extended with two fields the
 * contract requires:
 *
 *   - `code`          a stable machine code clients branch on, never the message;
 *   - `correlationId` ties the response to the logs and audit records of the request
 *                     that produced it, so a user-reported failure is findable.
 *
 * One shape means a client writes one error handler. Error responses never include
 * stack traces, SQL, internal identifiers or the underlying exception message — those
 * leak structure and sometimes data (docs/17).
 */
export interface ProblemResponse {
  /** Stable URI identifying the error class. */
  type: string;
  /** Short human description. Not for parsing. */
  title: string;
  /** Mirrors the HTTP status. */
  status: number;
  /** Explanation for this instance. */
  detail: string;
  /** The request path. */
  instance: string;
  /** Stable machine code — clients branch on this. */
  code: ProblemCode;
  correlationId: string;
  /** Field-level detail; present only for validation failures. */
  errors?: ProblemDetail[];
}

/** Base URI for problem types. Kept here so no call site invents its own. */
export const PROBLEM_TYPE_BASE = 'https://servicehub.example/problems/';

/** Transport-level status per code. Kept here so it cannot drift per call site. */
export const PROBLEM_STATUS: Record<ProblemCode, number> = {
  VALIDATION_FAILED: 422,
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  CONFLICT: 409,
  DUPLICATE: 409,
  VERSION_CONFLICT: 409,
  ACCOUNT_LOCKED: 423,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Short human title per code (RFC 7807 `title`). */
export const PROBLEM_TITLE: Record<ProblemCode, string> = {
  VALIDATION_FAILED: 'Validation failed',
  MALFORMED_REQUEST: 'Malformed request',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  ILLEGAL_TRANSITION: 'Illegal state transition',
  CONFLICT: 'Conflict',
  DUPLICATE: 'Duplicate resource',
  VERSION_CONFLICT: 'Version conflict',
  ACCOUNT_LOCKED: 'Account locked',
  RATE_LIMITED: 'Too many requests',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  INTERNAL: 'Internal server error',
  SERVICE_UNAVAILABLE: 'Service unavailable',
};

/** URI slug per code (RFC 7807 `type`). */
const PROBLEM_SLUG: Record<ProblemCode, string> = {
  VALIDATION_FAILED: 'validation-failed',
  MALFORMED_REQUEST: 'malformed-request',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
  ILLEGAL_TRANSITION: 'illegal-transition',
  CONFLICT: 'conflict',
  DUPLICATE: 'duplicate',
  VERSION_CONFLICT: 'version-conflict',
  ACCOUNT_LOCKED: 'account-locked',
  RATE_LIMITED: 'rate-limited',
  PAYLOAD_TOO_LARGE: 'payload-too-large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported-media-type',
  INTERNAL: 'internal',
  SERVICE_UNAVAILABLE: 'service-unavailable',
};

export function problem(input: {
  code: ProblemCode;
  detail: string;
  correlationId: string;
  instance: string;
  errors?: ProblemDetail[];
}): ProblemResponse {
  return {
    type: `${PROBLEM_TYPE_BASE}${PROBLEM_SLUG[input.code]}`,
    title: PROBLEM_TITLE[input.code],
    status: PROBLEM_STATUS[input.code],
    detail: input.detail,
    instance: input.instance,
    code: input.code,
    correlationId: input.correlationId,
    ...(input.errors && input.errors.length > 0 ? { errors: input.errors } : {}),
  };
}
