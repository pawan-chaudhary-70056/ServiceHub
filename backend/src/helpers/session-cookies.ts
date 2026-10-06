import { config, isProduction } from '../config';
import { serializeCookie } from './cookies';

/**
 * Session and CSRF cookie construction (`ADR-0001`, docs/06 §2).
 *
 * The attributes are the security control, so they are assembled in exactly one place:
 *
 *   - The SESSION cookie is `HttpOnly`, so client script cannot read it — an XSS cannot
 *     exfiltrate the session (docs/06 §9). It is `SameSite=Lax`, so it is not attached to
 *     cross-site POSTs, and `Secure` in production so it never travels in clear text.
 *   - The CSRF cookie is deliberately **not** `HttpOnly`: it must be readable by the SPA
 *     so it can echo the value in `X-CSRF-Token`. That is the double-submit pattern —
 *     the cookie proves the header came from our own origin, not a cross-site form.
 *
 * The CSRF value alone grants nothing; it is only ever compared against the session.
 */

/** Both cookies issued at login/accept, as `Set-Cookie` values. */
export function sessionCookieHeaders(tokens: {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}): string[] {
  const maxAgeSeconds = Math.max(0, Math.floor((tokens.expiresAt.getTime() - Date.now()) / 1000));

  return [
    serializeCookie(config.SESSION_COOKIE_NAME, tokens.sessionToken, {
      maxAgeSeconds,
      httpOnly: true,
      secure: isProduction,
      sameSite: 'Lax',
      path: '/',
    }),
    serializeCookie(config.CSRF_COOKIE_NAME, tokens.csrfToken, {
      maxAgeSeconds,
      httpOnly: false,
      secure: isProduction,
      sameSite: 'Lax',
      path: '/',
    }),
  ];
}

/** Clears both cookies on logout. `Max-Age=0` is the deletion instruction. */
export function clearedSessionCookieHeaders(): string[] {
  const options = {
    maxAgeSeconds: 0,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'Lax' as const,
    path: '/',
  };

  return [
    serializeCookie(config.SESSION_COOKIE_NAME, '', options),
    serializeCookie(config.CSRF_COOKIE_NAME, '', { ...options, httpOnly: false }),
  ];
}
