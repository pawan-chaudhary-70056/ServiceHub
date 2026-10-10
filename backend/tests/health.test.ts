import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

/**
 * API-level tests (docs/37 §5).
 *
 * These assert the *contract* — status codes, the problem+json shape, the correlation
 * id, the base path — rather than internal implementation. They deliberately do not
 * require a running database: liveness must not depend on one (docs/34 §6), and the
 * readiness assertion is written to hold whether or not a database is reachable.
 */
const app = createApp();

const BASE = '/api/v1';

describe('GET /api/v1/health/live', () => {
  it('reports liveness without requiring the database', async () => {
    const response = await request(app).get(`${BASE}/health/live`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('GET /api/v1/health/ready', () => {
  it('returns 200 when ready, or a well-formed 503 problem when not', async () => {
    const response = await request(app).get(`${BASE}/health/ready`);

    // Readiness legitimately depends on the database, so both outcomes are valid
    // depending on whether one is reachable in this environment.
    expect([200, 503]).toContain(response.status);

    if (response.status === 200) {
      expect(response.body).toMatchObject({ status: 'ready' });
      expect(Array.isArray(response.body.checks)).toBe(true);
      return;
    }

    // The failure path must still honour the single error contract (docs/11 §4).
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
    expect(typeof response.body.correlationId).toBe('string');
  });
});

describe('security headers (docs/17 §5)', () => {
  it('sends the pinned set on every response, not library defaults', async () => {
    const response = await request(app).get(`${BASE}/health/live`);

    const csp = response.headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No unsafe-inline for scripts — the directive docs/17 §5 calls out explicitly.
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');

    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['strict-transport-security']).toContain('includeSubDomains');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    // The framework must not advertise itself (docs/17).
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('error contract', () => {
  it('returns a NOT_FOUND problem for an unmatched route', async () => {
    const response = await request(app).get(`${BASE}/does-not-exist`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // RFC 7807 fields required by docs/11 §4.
    expect(response.body).toMatchObject({
      type: expect.stringContaining('/problems/not-found'),
      title: 'Not found',
      instance: `${BASE}/does-not-exist`,
    });
    // No stack trace or internal detail may leak (docs/17).
    expect(response.body).not.toHaveProperty('stack');
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('echoes a correlation id on every response so a failure is findable', async () => {
    const response = await request(app).get(`${BASE}/does-not-exist`);

    expect(response.headers['x-correlation-id']).toBeTruthy();
    expect(response.body.correlationId).toBe(response.headers['x-correlation-id']);
  });

  it('propagates a client-supplied correlation id across the request', async () => {
    const supplied = 'trace-abc-123';
    const response = await request(app)
      .get(`${BASE}/does-not-exist`)
      .set('x-correlation-id', supplied);

    expect(response.headers['x-correlation-id']).toBe(supplied);
  });

  it('rejects malformed JSON with 400 MALFORMED_REQUEST, not a raw parser error', async () => {
    const response = await request(app)
      .post(`${BASE}/does-not-exist`)
      .set('content-type', 'application/json')
      .send('{"unterminated":');

    // `400` means unparseable; `422` means parsed but invalid (docs/11 §3, docs/12 §9).
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('MALFORMED_REQUEST');
  });
});
