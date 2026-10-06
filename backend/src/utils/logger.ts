import pino, { type Logger } from 'pino';
import { config, isProduction } from '../config';

/**
 * Structured logging (docs/34 §3).
 *
 * Two rules drive this configuration:
 *
 *   L1 — Never log secrets, tokens, passwords or sensitive request bodies. The
 *        `redact` list below is the mechanism; it is not optional, because a leaked
 *        token in a log file is a live credential and logs are widely readable.
 *   L2 — PII is minimised. Logs do not carry the same retention discipline as the
 *        database, so identifiers are preferred over payloads (docs/19).
 *
 * Logs go to stdout as JSON in every environment: the application writes no log
 * files, because a container that writes to local disk is stateful and loses its
 * logs on restart (docs/34 §3.3).
 */
export const logger: Logger = pino({
  level: config.LOG_LEVEL,
  // Human-readable locally; machine-parseable JSON everywhere else.
  transport: isProduction
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'currentPassword',
      'newPassword',
      'token',
      'accessToken',
      'refreshToken',
      'secret',
      'authorization',
      'cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.secret',
    ],
    censor: '[redacted]',
  },
  base: undefined, // no pid/hostname noise; the platform supplies that context
});

/** Child logger bound to a correlation id, used per request (docs/34 §3.4). */
export function childLogger(correlationId: string): Logger {
  return logger.child({ correlationId });
}

export type { Logger };
