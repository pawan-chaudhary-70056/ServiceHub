/**
 * The single API client for the SPA (docs/14).
 *
 * One place performs `fetch`, so one place owns: the base URL, JSON encoding, the
 * problem-response shape, and error typing. Components never call `fetch` directly,
 * because that is how error handling drifts per screen and how a credential ends up in
 * the wrong header.
 *
 * Security notes that matter here:
 *   - No credential is stored in `localStorage` by this module. Sessions are
 *     server-side (`ADR-0001`): the client relies on cookies and sends
 *     `credentials: 'include'`, and the server sets `HttpOnly`. A token must never be
 *     persisted here (docs/06, docs/17).
 *   - State-changing requests must carry the `X-CSRF-Token` header once auth lands
 *     (`ADR-0001`, docs/11 §8); this client is the single place that will add it.
 *   - Errors carry the server's correlation id so a user can quote it in a support
 *     ticket and someone can actually find the request (docs/34 §3.4).
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const CSRF_COOKIE_NAME = import.meta.env.VITE_CSRF_COOKIE_NAME ?? 'servicehub_csrf';

/**
 * Reads a cookie by name from `document.cookie`.
 *
 * Only the CSRF cookie is ever read here: the session cookie is `HttpOnly` and
 * deliberately invisible to script (`ADR-0001`). If this function is extended to read
 * another cookie, that cookie must be one the server intends the client to see.
 */
function readCookie(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) {
      try {
        return decodeURIComponent(part.slice(prefix.length));
      } catch {
        return part.slice(prefix.length);
      }
    }
  }
  return undefined;
}

/** Field-level validation detail, mirroring the server's problem response (docs/11 §4). */
export interface ProblemFieldError {
  field?: string;
  message: string;
  code?: string;
}

/**
 * The RFC 7807 `application/problem+json` body (docs/11 §4). `code` and
 * `correlationId` are the two fields the contract adds to the standard shape.
 */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  correlationId: string;
  errors?: ProblemFieldError[];
}

/** Typed error for every non-2xx response. Never thrown for a network failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly errors: ProblemFieldError[];

  constructor(status: number, body: ProblemBody | undefined) {
    super(body?.detail ?? body?.title ?? 'The request failed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? 'INTERNAL';
    this.correlationId = body?.correlationId ?? 'unknown';
    this.errors = body?.errors ?? [];
  }

  /** True when the caller is not authenticated and could sign in to proceed. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** The caller is authenticated but not permitted. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * The record is absent — or the caller may not know it exists. The API does not
   * distinguish the two, deliberately, so the UI must not either (docs/17).
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }
}

/** Raised when the request never reached the server. Distinct from an API rejection. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the server. Check your connection and try again.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Aborts the request, e.g. when the component unmounts. */
  signal?: AbortSignal;
  /** Client-generated key so a repeated submit is a no-op rather than a duplicate. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined;
  }

  try {
    return await response.json();
  } catch {
    // A malformed body must not mask the status code.
    return undefined;
  }
}

export async function apiRequest<TResponse>(
  path: string,
  options: RequestOptions = {},
): Promise<TResponse> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // Repeating a mutation with the same key must not create a second effect (docs/11).
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  // Double-submit CSRF (`ADR-0001`, docs/11 §8): a state-changing request must echo the
  // readable CSRF cookie in a custom header. The server compares it against the digest
  // stored on the session. Safe methods are exempt by contract.
  const method = options.method ?? 'GET';
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      // Required by server-side sessions (`ADR-0001`): the browser must attach the
      // session cookie.
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // An aborted request is not a failure; let the caller's cancellation propagate.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new NetworkError(error);
  }

  const body = await parseBody(response);

  if (!response.ok) {
    throw new ApiError(response.status, isProblemBody(body) ? body : undefined);
  }

  return body as TResponse;
}

/**
 * Uploads a `FormData` body (multipart) — the file pipeline's client half
 * (docs/19 §7.2).
 *
 * Kept beside `apiRequest` so this module remains the only place that performs `fetch`:
 * the same CSRF header, credential policy, problem parsing and error typing apply, and
 * the only difference is that the browser — not this module — sets the multipart content
 * type, because a hand-set one would lose the boundary.
 */
export async function apiUpload<TResponse>(
  path: string,
  form: FormData,
  signal?: AbortSignal,
): Promise<TResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const csrf = readCookie(CSRF_COOKIE_NAME);
  if (csrf) {
    headers['X-CSRF-Token'] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: form,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new NetworkError(error);
  }

  const body = await parseBody(response);
  if (!response.ok) {
    throw new ApiError(response.status, isProblemBody(body) ? body : undefined);
  }
  return body as TResponse;
}

/**
 * A downloaded file's bytes plus the server's chosen filename (`docs/30` §5).
 */
export interface DownloadedFile {
  filename: string;
  blob: Blob;
}

/**
 * Fetches a binary/CSV response as a file. Kept here, beside `apiRequest`, so the SPA has
 * exactly one module that performs `fetch` and one place that maps a failure to an
 * `ApiError`. A download that failed must surface the same problem body a JSON call would,
 * not an opaque empty string.
 */
export async function apiDownload(path: string, signal?: AbortSignal): Promise<DownloadedFile> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new NetworkError(error);
  }

  if (!response.ok) {
    const body = await parseBody(response);
    throw new ApiError(response.status, isProblemBody(body) ? body : undefined);
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
  return { filename, blob: await response.blob() };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Recognises the docs/11 §4 envelope: `code` and `correlationId` are always present. */
function isProblemBody(value: unknown): value is ProblemBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'string' && typeof candidate.correlationId === 'string';
}

export { BASE_URL };
