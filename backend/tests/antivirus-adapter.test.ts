import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  antivirusAdapter,
  createClamavHttpAdapter,
  isAntivirusConfigured,
  unsupportedAntivirusAdapter,
} from '../src/integrations/antivirus';

/**
 * Antivirus adapter tests (`docs/19` §7.2 step 7, docs/37 §2 unit level).
 *
 * The behaviour under test is **verdict mapping**, because the verdict is a gate: the scan
 * worker promotes a file to retrievable on `CLEAN`, quarantines it on `INFECTED`, and leaves
 * it unservable on anything else. The one mapping that must never happen is "could not ask"
 * becoming "clean", so every failure mode — timeout, refused connection, an unexpected status
 * — is asserted to be `UNAVAILABLE`.
 *
 * The adapter is constructed with an explicit URL rather than reading frozen configuration in
 * the call, which is what makes these cases reachable in a test at all.
 */

const SCANNER_URL = 'http://scanner.invalid/scan';

function stubFetch(implementation: typeof fetch): void {
  vi.stubGlobal('fetch', implementation);
}

function jsonResponse(status: number): Response {
  return new Response(null, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('antivirus adapter', () => {
  it('reports no scanner configured rather than assuming a file is safe', async () => {
    expect(unsupportedAntivirusAdapter.configured).toBe(false);

    const verdict = await unsupportedAntivirusAdapter.scan({
      data: Buffer.from('hello'),
      contentType: 'text/plain',
    });

    expect(verdict.verdict).toBe('UNAVAILABLE');
    expect(verdict.reason).toContain('ANTIVIRUS_URL');
  });

  it('leaves the scan step off when no URL is configured, which is the local default', () => {
    // The test environment sets no scanner, so the upload path promotes on the request path.
    // Asserted here so a future default that silently enables scanning is caught.
    expect(isAntivirusConfigured()).toBe(false);
    expect(antivirusAdapter()).toBe(unsupportedAntivirusAdapter);
  });

  it('maps a 200 from the scanner to CLEAN', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200));
    stubFetch(fetchMock as unknown as typeof fetch);

    const verdict = await createClamavHttpAdapter(SCANNER_URL).scan({
      data: Buffer.from('%PDF-1.7'),
      contentType: 'application/pdf',
    });

    expect(verdict).toEqual({ verdict: 'CLEAN' });

    // The bytes are posted, not a path: the backend has no shared filesystem for a
    // path-based scanner to read (docs/19 §7.1).
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(SCANNER_URL);
    expect(call?.[1]?.method).toBe('POST');
    const body = call?.[1]?.body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(body as Uint8Array).toString()).toBe('%PDF-1.7');
  });

  it('maps the scanner’s malware status to INFECTED', async () => {
    stubFetch((async () => jsonResponse(406)) as unknown as typeof fetch);

    const verdict = await createClamavHttpAdapter(SCANNER_URL).scan({
      data: Buffer.from('X5O!P%@AP'),
      contentType: 'application/octet-stream',
    });

    expect(verdict.verdict).toBe('INFECTED');
    expect(verdict.reason).toBeTruthy();
  });

  it('treats a scanner failure as UNAVAILABLE, never as clean', async () => {
    stubFetch((async () => jsonResponse(503)) as unknown as typeof fetch);

    const verdict = await createClamavHttpAdapter(SCANNER_URL).scan({
      data: Buffer.from('data'),
      contentType: 'text/plain',
    });

    expect(verdict.verdict).toBe('UNAVAILABLE');
    expect(verdict.reason).toContain('503');
  });

  it('treats an unexpected status as UNAVAILABLE', async () => {
    stubFetch((async () => jsonResponse(403)) as unknown as typeof fetch);

    const verdict = await createClamavHttpAdapter(SCANNER_URL).scan({
      data: Buffer.from('data'),
      contentType: 'text/plain',
    });

    expect(verdict.verdict).toBe('UNAVAILABLE');
    expect(verdict.reason).toContain('403');
  });

  it('treats an unreachable scanner as UNAVAILABLE', async () => {
    stubFetch((async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);

    const verdict = await createClamavHttpAdapter(SCANNER_URL).scan({
      data: Buffer.from('data'),
      contentType: 'text/plain',
    });

    expect(verdict.verdict).toBe('UNAVAILABLE');
    expect(verdict.reason).toBe('The scanner could not be reached.');
  });

  it('treats a timeout as UNAVAILABLE, and aborts the request', async () => {
    let aborted = false;
    stubFetch(
      ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })) as unknown as typeof fetch,
    );

    const verdict = await createClamavHttpAdapter(SCANNER_URL, 5).scan({
      data: Buffer.from('data'),
      contentType: 'text/plain',
    });

    expect(aborted).toBe(true);
    expect(verdict.verdict).toBe('UNAVAILABLE');
    expect(verdict.reason).toContain('timeout');
  });
});
