import { describe, expect, it } from 'vitest';
import { parseCookies, serializeCookie } from '../src/helpers/cookies';
import { hashPassword, safeEqual, sha256, verifyPassword } from '../src/helpers/crypto';
import { validatePasswordPolicy } from '../src/helpers/password';
import { isSessionExpired, newSessionWindow, refreshedIdleExpiry } from '../src/helpers/session';

/**
 * Auth helper unit tests (docs/37 §3 level 1).
 *
 * These cover the pure rules the identity slice is built from — password policy, cookie
 * attributes, session clocks and the token digest — without a database. The integration
 * behaviour (login, lockout, provisioning) lives in `identity.integration.test.ts`.
 */

describe('validatePasswordPolicy', () => {
  it('accepts a policy-conforming password', () => {
    expect(validatePasswordPolicy('correct-horse-battery!')).toEqual([]);
  });

  it('rejects a password shorter than the minimum', () => {
    const problems = validatePasswordPolicy('short1!');
    expect(problems.some((problem) => problem.code === 'TOO_SHORT')).toBe(true);
  });

  it('rejects leading or trailing whitespace rather than silently trimming it', () => {
    const problems = validatePasswordPolicy(' correct-horse-battery!');
    expect(problems.some((problem) => problem.code === 'LEADING_OR_TRAILING_SPACE')).toBe(true);
  });

  it('rejects a password containing the email local part', () => {
    const problems = validatePasswordPolicy('MyName-alice-1234', { email: 'alice@example.test' });
    expect(problems.some((problem) => problem.code === 'CONTAINS_EMAIL')).toBe(true);
  });

  it('rejects a password containing the display name', () => {
    const problems = validatePasswordPolicy('Jonathan-secret-42', { displayName: 'Jonathan' });
    expect(problems.some((problem) => problem.code === 'CONTAINS_NAME')).toBe(true);
  });
});

describe('cookies', () => {
  it('parses a Cookie header into a name→value map', () => {
    expect(parseCookies('a=1; b=two; c=three')).toEqual({ a: '1', b: 'two', c: 'three' });
  });

  it('percent-decodes values and skips malformed segments', () => {
    expect(parseCookies('token=a%2Fb; nope; =blank; ok=1')).toEqual({ token: 'a/b', ok: '1' });
  });

  it('returns an empty map for a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('serialises the security attributes of a session cookie', () => {
    const value = serializeCookie('sid', 'value/with=chars', {
      maxAgeSeconds: 60,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
    expect(value).toBe(
      'sid=value%2Fwith%3Dchars; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('omits optional attributes when not requested', () => {
    expect(serializeCookie('sid', 'x')).toBe('sid=x; Path=/');
  });
});

describe('session clock', () => {
  it('sets the idle window inside the absolute window', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const window = newSessionWindow(now);
    expect(window.idleExpiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(window.absoluteExpiresAt.getTime()).toBeGreaterThan(window.idleExpiresAt.getTime());
  });

  it('never extends the idle expiry past the absolute ceiling', () => {
    const absolute = new Date(Date.now() + 60_000);
    const farFuture = new Date(Date.now() + 86_400_000);
    expect(refreshedIdleExpiry(absolute, farFuture).getTime()).toBe(absolute.getTime());
  });

  it('treats a revoked session as expired', () => {
    const future = new Date(Date.now() + 60_000);
    expect(
      isSessionExpired({ idleExpiresAt: future, absoluteExpiresAt: future, revokedAt: new Date() }),
    ).toBe(true);
  });

  it('treats a session past either clock as expired', () => {
    const past = new Date(Date.now() - 1);
    const future = new Date(Date.now() + 60_000);
    expect(
      isSessionExpired({ idleExpiresAt: past, absoluteExpiresAt: future, revokedAt: null }),
    ).toBe(true);
    expect(
      isSessionExpired({ idleExpiresAt: future, absoluteExpiresAt: past, revokedAt: null }),
    ).toBe(true);
  });

  it('treats a live session as valid', () => {
    const future = new Date(Date.now() + 60_000);
    expect(
      isSessionExpired({ idleExpiresAt: future, absoluteExpiresAt: future, revokedAt: null }),
    ).toBe(false);
  });
});

describe('crypto', () => {
  it('produces a stable SHA-256 digest for a token', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).toHaveLength(64);
  });

  it('compares digests in constant time and rejects unequal lengths safely', () => {
    expect(safeEqual(sha256('a'), sha256('a'))).toBe(true);
    expect(safeEqual(sha256('a'), sha256('b'))).toBe(false);
    // Must not throw on unequal lengths (timingSafeEqual would).
    expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
  });

  it('verifies an Argon2id hash and fails closed on a malformed hash', async () => {
    const hash = await hashPassword('correct-horse-battery!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct-horse-battery!')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
