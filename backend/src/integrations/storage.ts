import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { config } from '../config';
import { InternalError } from '../utils/errors';

/**
 * Object storage — the domain's side of `ADR-0004` (docs/19 §7.1).
 *
 * The domain owns this interface; the driver is chosen by configuration, so swapping the
 * S3 vendor or a test fake touches one file (integrations rule 2). Two rules are
 * load-bearing:
 *
 *   1. **Backends keep no file bytes.** The API receives the multipart body, writes it
 *      through this interface and persists metadata only, so an instance never becomes
 *      the only place a file exists (docs/19 §7.1).
 *   2. **Downloads go through a short-lived signed URL when the backend supports one**
 *      (docs/19 §7.3). The local driver returns `null` and the API streams the file
 *      itself — single-instance development is the case where "not served from the
 *      application origin" cannot hold, and it is recorded as such rather than hidden.
 *
 * The `s3` driver is any S3-compatible endpoint and is the only driver permitted in
 * production (`env.ts` cross-field rule, `ADR-0004`).
 */

export interface FileStorage {
  readonly driver: 'local' | 's3';
  /** Writes the object under a server-generated key. Never receives a client filename. */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** A short-lived signed URL (docs/19 §7.3), or `null` when the backend cannot issue one. */
  signedDownloadUrl(key: string): Promise<string | null>;
  /** Local streaming support; `null` for drivers that serve only by URL. */
  open(key: string): Promise<Readable | null>;
  remove(key: string): Promise<void>;
}

/**
 * Storage keys are server-generated and unguessable (docs/19 §7.2 rule 3). The shape is
 * `<tenant>/<uuid>`: two segments, each charset-restricted, so a key can never traverse
 * out of the storage root no matter what produced it.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function newStorageKey(organizationId: string): string {
  return `${organizationId}/${randomUUID()}`;
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new InternalError('Malformed storage key.');
  }
}

// ---------------------------------------------------------------------------
// Local driver (development and tests)
// ---------------------------------------------------------------------------

class LocalStorage implements FileStorage {
  readonly driver = 'local' as const;
  private readonly root = path.resolve(config.FILE_STORAGE_DIR);

  private resolve(key: string): string {
    assertKey(key);
    const full = path.resolve(this.root, key);
    // Defence in depth: containment is re-checked after resolution, so even a key that
    // somehow passed the pattern cannot address a path outside the root.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new InternalError('Storage key escapes the storage root.');
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  signedDownloadUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async open(key: string): Promise<Readable | null> {
    const full = this.resolve(key);
    try {
      await fs.access(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return createReadStream(full);
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

// ---------------------------------------------------------------------------
// S3-compatible driver (production, ADR-0004) — SigV4, no vendor SDK
// ---------------------------------------------------------------------------

interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function s3Settings(): S3Settings {
  const missing =
    !config.S3_ENDPOINT ||
    !config.S3_BUCKET ||
    !config.S3_ACCESS_KEY_ID ||
    !config.S3_SECRET_ACCESS_KEY;
  if (missing) {
    throw new InternalError('S3 storage is selected but its configuration is incomplete.');
  }
  return {
    endpoint: config.S3_ENDPOINT as string,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET as string,
    accessKeyId: config.S3_ACCESS_KEY_ID as string,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY as string,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  };
}

/** AWS UriEncode (RFC 3986 with `~` unreserved): stricter than `encodeURIComponent`. */
function uriEncode(value: string, encodeSlash: boolean): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, encodeSlash ? '%2F' : '/');
}

function objectUrl(settings: S3Settings, key: string): { url: URL; canonicalUri: string } {
  const endpoint = new URL(settings.endpoint);
  const segments = key
    .split('/')
    .map((part) => uriEncode(part, false))
    .join('/');

  if (settings.forcePathStyle) {
    const canonicalUri = `/${settings.bucket}/${segments}`;
    return { url: new URL(`${endpoint.origin}${canonicalUri}`), canonicalUri };
  }

  const host = `${settings.bucket}.${endpoint.host}`;
  const canonicalUri = `/${segments}`;
  return { url: new URL(`${endpoint.protocol}//${host}${canonicalUri}`), canonicalUri };
}

const sha256Hex = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** A short-lived, signed GET URL (docs/19 §7.3): the API authorises first, then hands
 * over — the signature expires in `SIGNED_URL_TTL_SECONDS`, so a leaked link is inert. */
function presignGet(settings: S3Settings, key: string): string {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261008T101112Z
  const dateStamp = amzDate.slice(0, 8);

  const { url, canonicalUri } = objectUrl(settings, key);
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${settings.accessKeyId}/${dateStamp}/${settings.region}/s3/aws4_request`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(config.SIGNED_URL_TTL_SECONDS),
    'X-Amz-SignedHeaders': 'host',
  });

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery(params),
    `host:${url.host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${settings.region}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey(settings.secretAccessKey, dateStamp, settings.region, 's3'),
  )
    .update(stringToSign)
    .digest('hex');

  params.set('X-Amz-Signature', signature);
  url.search = params.toString();
  return url.toString();
}

/** Header-signed request (PUT/DELETE) — the body hash is part of the signature, so the
 * bytes cannot be swapped in flight. */
function signedRequest(
  settings: S3Settings,
  method: 'PUT' | 'DELETE',
  key: string,
  body: Buffer | null,
  contentType: string,
): { url: URL; headers: Record<string, string> } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const { url, canonicalUri } = objectUrl(settings, key);
  const payloadHash = body ? sha256Hex(body) : sha256Hex('');

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(method === 'PUT' ? { 'content-type': contentType } : {}),
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${(headers[name] ?? '').trim()}\n`)
    .join('');

  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${settings.region}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey(settings.secretAccessKey, dateStamp, settings.region, 's3'),
  )
    .update(stringToSign)
    .digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${dateStamp}/${settings.region}/s3/aws4_request, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  return { url, headers };
}

class S3Storage implements FileStorage {
  readonly driver = 's3' as const;

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    // The same key discipline as the local driver: a key that could address another
    // tenant's prefix, or climb out of the bucket, is refused before a request is built
    // (docs/19 §7.2 rule 3). Both drivers enforce it, so a caller cannot depend on the
    // one that happens to be configured being the forgiving one.
    assertKey(key);
    const settings = s3Settings();
    const { url, headers } = signedRequest(settings, 'PUT', key, data, contentType);
    const response = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(data) });
    if (!response.ok) {
      throw new InternalError(`Object storage rejected the upload (status ${response.status}).`);
    }
  }

  async signedDownloadUrl(key: string): Promise<string | null> {
    assertKey(key);
    return presignGet(s3Settings(), key);
  }

  open(): Promise<Readable | null> {
    // S3 serves by URL; nothing streams through the backend (docs/19 §7.1).
    return Promise.resolve(null);
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    const settings = s3Settings();
    const { url, headers } = signedRequest(
      settings,
      'DELETE',
      key,
      null,
      'application/octet-stream',
    );
    const response = await fetch(url, { method: 'DELETE', headers });
    if (!response.ok && response.status !== 404) {
      throw new InternalError(`Object storage rejected the delete (status ${response.status}).`);
    }
  }
}

/**
 * The configured driver. `local` keeps bytes on disk for a single-instance dev/test
 * stack; `s3` is `ADR-0004` realised and is enforced in production by `env.ts`.
 */
export function fileStorage(): FileStorage {
  return config.FILE_STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
}
