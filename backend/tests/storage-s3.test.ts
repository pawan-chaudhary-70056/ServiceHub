import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Object-storage driver tests (docs/19 §7.1/§7.3, `ADR-0004`).
 *
 * `s3` is the **only** driver permitted in production, so its two security-relevant
 * behaviours are pinned here rather than assumed:
 *
 *   - a download URL is **signed and short-lived** (`§7.3`): the API authorises first and
 *     hands over a URL that expires, so a leaked link is worthless;
 *   - a write is **header-signed including the payload hash**, so the bytes cannot be
 *     swapped in flight.
 *
 * No network is touched: the driver's `fetch` is stubbed, and only the request it builds
 * is inspected. The environment is set before the module graph is loaded, because the S3
 * configuration is validated at boot (`env.ts`).
 */

process.env.FILE_STORAGE_DRIVER = 's3';
process.env.S3_ENDPOINT = 'https://s3.example.test';
process.env.S3_REGION = 'eu-west-2';
process.env.S3_BUCKET = 'servicehub-files';
// Deliberately not shaped like a real AWS key id (`AKIA…`/`ASIA…`): the CI credential
// scan runs over tests too, and a fixture that looks like a live key is a false positive
// that teaches people to ignore the gate (docs/20 §3). The signing maths does not care
// about the prefix.
process.env.S3_ACCESS_KEY_ID = 'EXAMPLEACCESSKEYID0000';
process.env.S3_SECRET_ACCESS_KEY = 'example-secret-access-key-value';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.SIGNED_URL_TTL_SECONDS = '300';

type StorageModule = typeof import('../src/integrations/storage');
let storage: StorageModule;

beforeAll(async () => {
  // Imported after the environment is in place: config is validated at import time.
  storage = await import('../src/integrations/storage');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = '0191f2a4-8e5b-7000-8000-0123456789ab/2f6a1c4e-0000-4000-8000-000000000001';

describe('S3 storage driver', () => {
  it('is selected by configuration and issues a signed, expiring download URL', async () => {
    const driver = storage.fileStorage();
    expect(driver.driver).toBe('s3');

    const url = new URL((await driver.signedDownloadUrl(KEY)) ?? '');
    expect(url.origin).toBe('https://s3.example.test');
    // Path-style addressing, so the bucket cannot be mistaken for a subdomain of ours.
    expect(url.pathname).toBe(`/servicehub-files/${KEY}`);

    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^EXAMPLEACCESSKEYID0000\/\d{8}\/eu-west-2\/s3\/aws4_request$/,
    );
    expect(url.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/);
    // A real HMAC-SHA256 signature, not a placeholder.
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the object, so a different key yields a different signature', async () => {
    const driver = storage.fileStorage();
    const first = new URL((await driver.signedDownloadUrl(KEY)) ?? '');
    const second = new URL(
      (await driver.signedDownloadUrl(KEY.replace('000000000001', '000000000002'))) ?? '',
    );

    expect(second.pathname).not.toBe(first.pathname);
    expect(second.searchParams.get('X-Amz-Signature')).not.toBe(
      first.searchParams.get('X-Amz-Signature'),
    );
  });

  it('signs a write with the payload hash and the credential', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await storage.fileStorage().put(KEY, Buffer.from('contract pdf bytes'), 'application/pdf');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`https://s3.example.test/servicehub-files/${KEY}`);
    expect(init.method).toBe('PUT');

    const headers = init.headers as Record<string, string>;
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=EXAMPLEACCESSKEYID0000\/\d{8}\/eu-west-2\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    // The body hash is part of the signature, so the bytes cannot be swapped in flight.
    expect(headers.authorization).toContain('x-amz-content-sha256');
  });

  it('surfaces a rejected write instead of reporting success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 })),
    );

    await expect(
      storage.fileStorage().put(KEY, Buffer.from('bytes'), 'application/pdf'),
    ).rejects.toThrowError(/status 403/);
  });

  it('generates an unguessable, tenant-prefixed key and rejects a traversal key', async () => {
    const key = storage.newStorageKey('0191f2a4-8e5b-7000-8000-0123456789ab');
    expect(key).toMatch(
      /^0191f2a4-8e5b-7000-8000-0123456789ab\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // A key that could address another tenant's prefix or escape the root is refused
    // before any request is built (docs/19 §7.2 rule 3).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      storage.fileStorage().put('../outside', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrowError(/Malformed storage key/);
  });
});
