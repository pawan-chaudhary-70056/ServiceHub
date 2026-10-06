import type { NextFunction, Request, Response } from 'express';
import { PROBLEM_STATUS, problem } from '../helpers/problem';
import { AppError, InternalError, MalformedRequestError, isAppError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * The only place an error becomes an HTTP response (docs/11 §4, docs/38 §2).
 *
 * Rules:
 *   - Expected errors (validation, authorization, not-found) are logged at `warn` with
 *     no stack. They are normal traffic and must not drown real failures (docs/34 L6).
 *   - Unexpected errors are logged at `error` with the stack and the correlation id, but
 *     the client receives a generic message. Stack traces, SQL and internal ids are
 *     never returned (docs/17).
 *   - The response media type is `application/problem+json` (docs/11 §1).
 *   - The audit trail is unaffected by a failed request: an audit record is written in
 *     the mutation's transaction, so a rolled-back mutation leaves no audit entry and a
 *     committed one could not have skipped it (docs/31 §3.1).
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // A response already in flight cannot be reshaped.
  if (res.headersSent) {
    next(error);
    return;
  }

  const correlationId = req.correlationId ?? 'unknown';
  const appError = normalise(error);

  // `Retry-After` accompanies the responses that describe a caller-resolvable wait
  // (docs/11 §8). The limiter sets it for 429 before delegating; lockout sets it at
  // the throw site, so nothing is added here that the contract does not require.
  if (appError.code === 'RATE_LIMITED' || appError.code === 'ACCOUNT_LOCKED') {
    if (!res.hasHeader('Retry-After')) {
      res.setHeader('Retry-After', '60');
    }
  }

  if (appError.expected) {
    logger.warn(
      { correlationId, code: appError.code, path: req.path, method: req.method },
      appError.message,
    );
  } else {
    logger.error(
      {
        correlationId,
        code: appError.code,
        path: req.path,
        method: req.method,
        err: appError.cause ?? error,
      },
      'Unhandled request error',
    );
  }

  res
    .status(PROBLEM_STATUS[appError.code])
    .type('application/problem+json')
    .json(
      problem({
        code: appError.code,
        detail: appError.message,
        correlationId,
        instance: req.originalUrl || req.path,
        ...(appError.details ? { errors: appError.details } : {}),
      }),
    );
}

/**
 * Maps framework/transport errors onto application errors so the client never sees a
 * body parser's raw message.
 *
 * `400` vs `422` is deliberate (docs/11 §3): `400` means the request could not be
 * parsed at all; `422` means it parsed and failed validation, with field-level detail.
 */
function normalise(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  // Malformed JSON or a body that exceeds the parser limit, from `express.json()`.
  if (isBodyParserError(error)) {
    if (error.type === 'entity.too.large') {
      return new AppError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request body is too large.',
      });
    }
    if (error.type === 'encoding.unsupported') {
      return new AppError({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'The request body uses an unsupported encoding.',
      });
    }
    return new MalformedRequestError();
  }

  return new InternalError('An unexpected error occurred.', error);
}

interface BodyParserError {
  type?: string;
  status?: number;
  expose?: boolean;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof (error as BodyParserError).type === 'string'
  );
}
