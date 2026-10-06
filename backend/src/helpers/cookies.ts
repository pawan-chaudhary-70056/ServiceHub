/**
 * Minimal cookie read/write (docs/06 §2, docs/17).
 *
 * Cookies are parsed and serialised here rather than with a middleware dependency so
 * the exact attributes are visible in one place and reviewable. Getting a session
 * cookie attribute wrong (missing `HttpOnly`, missing `SameSite`) is a security defect,
 * so it should not be buried in a third-party default.
 *
 * `parseCookies` is deliberately forgiving: a malformed segment is skipped rather than
 * throwing, because a bad cookie must not turn every request into a 400.
 */

export interface CookieOptions {
  /** Seconds until expiry; omitted means a session cookie. */
  maxAgeSeconds?: number;
  path?: string;
  /** Prevents client-side script from reading the value (session cookie — docs/06 §2). */
  httpOnly?: boolean;
  /** Only sent over HTTPS. Applied in production. */
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Parses a `Cookie:` header into a name→value map. Last value wins on duplicates. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name.length === 0) {
      continue;
    }
    // Values may be percent-encoded by an intermediary; a decode failure falls back to
    // the raw value rather than dropping the cookie.
    const raw = part.slice(separator + 1).trim();
    cookies[name] = safeDecode(raw);
  }

  return cookies;
}

/** Serialises one `Set-Cookie` value. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);

  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join('; ');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
