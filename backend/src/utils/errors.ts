/**
 * Typed application errors (docs/38 §2: never throw bare strings).
 *
 * Services throw these; the error-handling middleware is the only place that turns
 * them into HTTP responses. That separation is what keeps business logic free of
 * `req`/`res` and makes the rules testable without HTTP.
 *
 * The codes and the response shape are owned by docs/11-API-CONTRACT.md §4. Codes are a
 * public contract: clients branch on `code`, never on the human-readable message, so a
 * code may be added but never renamed or repurposed.
 */

export const PROBLEM_CODES = [
  'VALIDATION_FAILED',
  'MALFORMED_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ILLEGAL_TRANSITION',
  'CONFLICT',
  'DUPLICATE',
  'VERSION_CONFLICT',
  'ACCOUNT_LOCKED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INTERNAL',
  'SERVICE_UNAVAILABLE',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * Field-level detail for validation failures (docs/11 §4).
 *
 * `field` uses dotted/bracket notation matching the request shape
 * (`approvers[0].id`) so a client can map an error onto a form control. Body issues
 * report the bare field path; a param or query issue is prefixed (`query.limit`) so a
 * field name shared between locations stays distinguishable.
 */
export interface ProblemDetail {
  field?: string;
  message: string;
  /** Stable machine sub-reason, e.g. a Zod issue code or a resource-specific code. */
  code?: string;
}

export interface AppErrorOptions {
  code: ProblemCode;
  /** Safe, human-readable message. Never includes internal detail or SQL. */
  message: string;
  /** Field-level detail for validation failures. */
  details?: ProblemDetail[];
  /** Marks an error as expected (logged at warn) versus unexpected (logged at error). */
  expected?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ProblemCode;
  readonly details?: ProblemDetail[];
  readonly expected: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.details = options.details;
    this.expected = options.expected ?? true;
  }
}

export class ValidationError extends AppError {
  constructor(details: ProblemDetail[], message = 'The request failed validation.') {
    super({ code: 'VALIDATION_FAILED', message, details });
    this.name = 'ValidationError';
  }
}

/** The request could not be parsed at all (docs/11 §3, docs/12 §9) — distinct from 422. */
export class MalformedRequestError extends AppError {
  constructor(message = 'The request body could not be parsed.') {
    super({ code: 'MALFORMED_REQUEST', message });
    this.name = 'MalformedRequestError';
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required.') {
    super({ code: 'UNAUTHENTICATED', message });
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Not-authorized for an action the caller may not perform at all.
 *
 * Note the deliberate companion rule in docs/17: a caller who may not *see* an object
 * receives NOT_FOUND, not FORBIDDEN, so the API does not disclose that the record
 * exists. That distinction is asserted by tests (docs/37 §5).
 */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super({ code: 'FORBIDDEN', message });
    this.name = 'ForbiddenError';
  }
}

/** Resource does not exist, or the caller may not know that it exists. */
export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super({ code: 'NOT_FOUND', message });
    this.name = 'NotFoundError';
  }
}

/** An illegal state-machine move (docs/11 §4). Distinct from a generic conflict. */
export class IllegalTransitionError extends AppError {
  constructor(message = 'That transition is not allowed from the current state.') {
    super({ code: 'ILLEGAL_TRANSITION', message });
    this.name = 'IllegalTransitionError';
  }
}

/** The resource is in a state that prevents the action (e.g. an item no longer requestable). */
export class ConflictError extends AppError {
  constructor(message = 'The resource is not in a state that allows this action.') {
    super({ code: 'CONFLICT', message });
    this.name = 'ConflictError';
  }
}

/** A uniqueness constraint the caller can resolve (duplicate reference, email, …). */
export class DuplicateError extends AppError {
  constructor(message = 'That value already exists.') {
    super({ code: 'DUPLICATE', message });
    this.name = 'DuplicateError';
  }
}

/** Optimistic-concurrency failure: the resource changed since the caller read it. */
export class VersionConflictError extends AppError {
  constructor(message = 'The resource was modified by someone else. Reload and retry.') {
    super({ code: 'VERSION_CONFLICT', message });
    this.name = 'VersionConflictError';
  }
}

/** Account lockout (docs/06 §6). The handler adds `Retry-After` where known. */
export class AccountLockedError extends AppError {
  constructor(message = 'This account is temporarily locked. Try again later.') {
    super({ code: 'ACCOUNT_LOCKED', message });
    this.name = 'AccountLockedError';
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Please retry shortly.') {
    super({ code: 'RATE_LIMITED', message });
    this.name = 'RateLimitedError';
  }
}

/** A dependency is unavailable and the request cannot be served (docs/11 §3). */
export class DependencyError extends AppError {
  constructor(message = 'A required dependency is unavailable.') {
    super({ code: 'SERVICE_UNAVAILABLE', message });
    this.name = 'DependencyError';
  }
}

/** Unexpected failure. Never surfaced verbatim to the client. */
export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred.', cause?: unknown) {
    super({ code: 'INTERNAL', message, expected: false, cause });
    this.name = 'InternalError';
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
