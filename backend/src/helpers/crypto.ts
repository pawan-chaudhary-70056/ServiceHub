import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { config } from '../config';

/**
 * Cryptographic primitives for identity and sessions (docs/06, docs/17).
 *
 * This module is a leaf: it holds no state and knows nothing about HTTP or the
 * database. Two rules are load-bearing:
 *
 *   1. Secrets are never stored, only their hash. A leaked token store must not yield
 *      live credentials, so session/invitation/reset tokens are persisted as SHA-256
 *      digests and compared with a timing-safe equality.
 *   2. Password hashing is Argon2id with the parameters mandated by docs/06 §4
 *      (memory ≥ 64 MiB, iterations ≥ 3). The floors are validated at boot in `env.ts`,
 *      so a misconfigured deploy cannot silently weaken hashing.
 *
 * SHA-256 is used for the *lookup* digest of a high-entropy random token, never for a
 * password. A password is low entropy and must use Argon2id; a 256-bit random token is
 * not brute-forceable, and a fast digest is the correct choice for an indexed lookup.
 */

/** A fresh opaque token with `bytes` of entropy (≥128 bits is required — docs/06 §2). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex SHA-256 digest, used for token lookup columns and CSRF secret comparison. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison.
 *
 * Guarded by length first because `timingSafeEqual` throws on unequal lengths; the
 * length of a fixed-size digest is not secret, so the early return leaks nothing.
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Argon2id hash of a password. Plaintext is never persisted (docs/06 §4). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: config.ARGON2_MEMORY_COST,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
  });
}

/**
 * Verify a password against its hash.
 *
 * A malformed or unrecognised hash returns `false` rather than throwing: a corrupt
 * credential row must fail closed as "wrong password", not as a 500 that reveals the
 * row exists.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A throwaway hash used to equalise login timing.
 *
 * When an email does not exist, the login path still performs an Argon2id verify
 * against this hash, so "unknown email" and "wrong password" take a comparable time.
 * Without it, response timing is a user-enumeration oracle (docs/06 §3, §9).
 *
 * Computed lazily and cached: hashing it at import time would add boot cost and the
 * value is only needed once, on the first failed lookup.
 */
let dummyHash: Promise<string> | null = null;

export function timingEqualisationHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken(16));
  return dummyHash;
}
