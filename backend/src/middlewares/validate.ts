import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { ValidationError, type ProblemDetail } from '../utils/errors';

/**
 * The validation boundary (docs/12-VALIDATION-RULES.md §1).
 *
 * Every input is validated here, at the edge of the application, with the same Zod
 * schemas that the OpenAPI document is generated from. Two consequences that the
 * architecture depends on:
 *
 *   1. An invalid request never reaches a service, so domain code can assume its inputs
 *      are shaped correctly and can focus on business rules.
 *   2. Client-side validation is UX only. It is never a control — it is trivially
 *      bypassed by calling the API directly.
 *
 * Parsed (and therefore coerced/defaulted) values are stashed rather than written back
 * onto `req`, because `req.query` is a read-only accessor in Express 5 and mutating
 * request objects is the kind of hidden state that makes handlers hard to reason about.
 *
 * Error fields are shaped for a form to consume: a body issue reports the bare field
 * path (`name`), while a param or query issue is prefixed (`query.limit`) so a field
 * name shared between locations stays distinguishable (docs/11 §4, docs/12 §9).
 */

export interface ValidationSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

export interface ValidatedData {
  body: unknown;
  params: unknown;
  query: unknown;
}

const VALIDATED_KEY = 'validated';

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const details: ProblemDetail[] = [];
    const validated: ValidatedData = {
      body: req.body,
      params: req.params,
      query: req.query,
    };

    for (const part of ['body', 'params', 'query'] as const) {
      const schema = schemas[part];
      if (!schema) {
        continue;
      }

      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
        continue;
      }

      for (const issue of result.error.issues) {
        details.push({
          // Body paths are the bare field path, because a form maps them directly to
          // its inputs. Params and query values are prefixed so a caller can tell where
          // the offending value came from when a field name appears in both.
          field: part === 'body' ? issue.path.join('.') : [part, ...issue.path].join('.'),
          message: issue.message,
          code: issue.code,
        });
      }
    }

    if (details.length > 0) {
      next(new ValidationError(details));
      return;
    }

    res.locals[VALIDATED_KEY] = validated;
    next();
  };
}

/** Typed accessor for validated input. Throws if the route forgot `validate`. */
export function validated<TBody = unknown, TParams = unknown, TQuery = unknown>(
  res: Response,
): { body: TBody; params: TParams; query: TQuery } {
  const data = res.locals[VALIDATED_KEY] as ValidatedData | undefined;

  if (!data) {
    // A programming error, not a user error: it must fail loudly in development and be
    // an INTERNAL problem in production rather than silently reading raw input.
    throw new Error('validated() called on a route without the validate() middleware.');
  }

  return data as { body: TBody; params: TParams; query: TQuery };
}
