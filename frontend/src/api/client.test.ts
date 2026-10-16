import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, BASE_URL, apiRequest } from './client';

/**
 * API client tests (docs/37 §2, docs/11 §4).
 *
 * The two behaviours asserted here are security-relevant and easy to regress:
 *
 *   - the double-submit CSRF header is attached to state-changing requests and NOT to
 *     safe reads (`ADR-0001`); and
 *   - a non-2xx response becomes a typed `ApiError` carrying the server's code and
 *     correlation id, which is what lets a screen show a quoteable reference.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
  } as unknown as Response;
}

function setCsrfCookie(value: string): void {
  document.cookie = `servicehub_csrf=${value}; path=/`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Expire the CSRF cookie so tests do not leak state into one another.
  document.cookie = 'servicehub_csrf=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('apiRequest CSRF handling', () => {
  it('attaches X-CSRF-Token to a state-changing request from the readable cookie', async () => {
    setCsrfCookie('csrf-value-123');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/logout', { method: 'POST' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('csrf-value-123');
  });

  it('does not attach X-CSRF-Token to a safe read', async () => {
    setCsrfCookie('csrf-value-123');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBeUndefined();
  });

  it('always requests with credentials so the session cookie travels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, undefined));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/logout', { method: 'POST' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('include');
  });
});

describe('apiRequest error envelope', () => {
  it('throws an ApiError carrying the server code and correlation id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have permission to perform this action.',
        instance: '/api/v1/platform/organizations',
        code: 'FORBIDDEN',
        correlationId: 'corr-1',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await apiRequest('/platform/organizations', { method: 'POST' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(403);
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.correlationId).toBe('corr-1');
    expect(apiError.isForbidden).toBe(true);
  });

  it('returns undefined for a 204 with no body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, undefined));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

/**
 * The base path is configuration, and it is the one misconfiguration that reads as an
 * outage: with no `/v1` in it every call is a `404`, which the shell can only describe as
 * "the API is unreachable" even though the API is answering. The path version is fixed by
 * `docs/11` §1, so any deployment form (relative, or an absolute origin) must end in it.
 */
describe('configured base path', () => {
  it('ends with the `/api/v1` prefix the contract fixes (docs/11 §1)', () => {
    expect(BASE_URL.endsWith('/api/v1')).toBe(true);
  });
});
