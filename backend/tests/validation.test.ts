import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../src/middlewares/error-handler';
import { validate, validated } from '../src/middlewares/validate';
import { cursorPaginationSchema, MAX_PAGE_SIZE } from '../src/validators';

/**
 * The validation boundary (docs/12) and the error envelope (docs/11 §4).
 *
 * Two things are worth testing here because they are rules rather than incidental
 * behaviour:
 *
 *   1. Invalid input never reaches the handler. A handler that "defensively" re-checks
 *      input hides a missing boundary.
 *   2. `limit` is bounded. An unbounded page size is an unbounded query, which is the
 *      database-protection failure the scalability strategy exists to prevent
 *      (docs/33 §7).
 */

const bodySchema = z.object({ name: z.string().min(1) });

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.post(
    '/things',
    validate({ body: bodySchema, query: cursorPaginationSchema }),
    (_req, res) => {
      const { body, query } = validated<{ name: string }, unknown, { limit: number }>(res);
      res.status(201).json({ received: body, limit: query.limit });
    },
  );

  app.use(errorHandler);
  return app;
}

const app = buildApp();

describe('validate middleware', () => {
  it('passes parsed and defaulted values to the handler', async () => {
    const response = await request(app).post('/things').send({ name: 'ok' });

    expect(response.status).toBe(201);
    // Coercion and defaults are applied before the handler sees the value.
    expect(response.body).toEqual({ received: { name: 'ok' }, limit: 25 });
  });

  it('rejects invalid input with 422 and a bare body field path', async () => {
    const response = await request(app).post('/things').send({ name: '' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    // Body issues report the bare field path so a form can map them to its inputs.
    expect(response.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name' })]),
    );
  });

  it('prefixes a query issue so the location is unambiguous', async () => {
    const response = await request(app)
      .post('/things')
      .query({ limit: MAX_PAGE_SIZE + 1 })
      .send({ name: 'ok' });

    expect(response.status).toBe(422);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'query.limit' })]),
    );
  });
});
