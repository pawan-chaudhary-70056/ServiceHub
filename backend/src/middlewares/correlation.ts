import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Assigns or propagates a correlation id (docs/34 §3.4).
 *
 * The id is echoed to the client on error responses so a user can report a failure
 * that is actually findable. It is also recorded on audit entries (docs/31), which is
 * what ties "the record changed" to "this request did it".
 *
 * A client-supplied id is accepted for propagation across services, but it is bounded
 * and sanitised: an unbounded header echoed into logs is a log-injection vector.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const header = req.header(CORRELATION_HEADER);
  const incoming =
    typeof header === 'string' && header.length > 0 && header.length <= 128
      ? // Keep it to a safe character set so it cannot forge log fields.
        header.replace(/[^A-Za-z0-9._:-]/g, '')
      : '';

  const id = incoming.length > 0 ? incoming : randomUUID();

  req.correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
}
