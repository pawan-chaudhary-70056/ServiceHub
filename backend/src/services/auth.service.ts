import { config } from '../config';
import {
  hashPassword,
  randomToken,
  sha256,
  timingEqualisationHash,
  verifyPassword,
} from '../helpers/crypto';
import type { Principal } from '../helpers/authorization';
import { isSessionExpired, newSessionWindow, refreshedIdleExpiry } from '../helpers/session';
import { validatePasswordPolicy } from '../helpers/password';
import { AccountLockedError, UnauthenticatedError, ValidationError } from '../utils/errors';
import { normalizeEmail, type TxClient } from '../models';
import {
  clearFailedAttempts,
  createCredential,
  createPasswordResetToken,
  createSession,
  findCredentialByUserId,
  findPasswordResetByTokenHash,
  findSessionByTokenHash,
  findUserByEmail,
  findUserById,
  invalidateOutstandingResets,
  listLiveSessionTokenHashes,
  markPasswordResetUsed,
  recordFailedAttempt,
  resolvePermissionKeys,
  revokeAllSessionsForUser,
  revokeSession,
  runInTransaction,
  touchSession,
  upsertCredential,
  writeAudit,
  writeAuditSafe,
  writeOutboxEvent,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import type { RequestMeta } from './context';
import {
  invalidateSessionCache,
  invalidateSessionCaches,
  readCachedSession,
  writeCachedSession,
} from './session-cache';

/**
 * Authentication service — docs/06, `ADR-0001`.
 *
 * The whole module is organised around two rules from the security doc:
 *
 *   1. **Uniform failure.** "Unknown email" and "wrong password" produce the same status,
 *      the same body and comparable timing (docs/06 §3). Any asymmetry here is a user
 *      enumeration oracle.
 *   2. **Immediate revocation.** Sessions are rows that can be revoked, and entitlements
 *      are resolved from the database on every request (docs/06 §7), so a role change or
 *      deactivation takes effect on the next request rather than at expiry.
 */

export interface AuthenticatedSession {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  user: {
    id: string;
    email: string;
    displayName: string;
    organizationId: string | null;
    isPlatformOperator: boolean;
  };
  permissions: string[];
}

const GENERIC_LOGIN_FAILURE = 'Email or password is incorrect.';

/**
 * Verifies credentials and issues a session (docs/06 §3).
 *
 * Lockout short-circuits before the hash comparison, so a locked account does not spend
 * Argon2 work on every guess; the response is `423` with a retry hint (`docs/06 §6`).
 */
export async function login(
  input: { email: string; password: string },
  meta: RequestMeta,
): Promise<AuthenticatedSession> {
  const email = normalizeEmail(input.email);
  const user = await findUserByEmail(email);

  if (!user) {
    // Spend comparable time so a missing email is not distinguishable by latency.
    await verifyPassword(await timingEqualisationHash(), input.password);
    await writeAuditSafe(failedLoginAudit(email, null, meta));
    throw new UnauthenticatedError(GENERIC_LOGIN_FAILURE);
  }

  const credential = await findCredentialByUserId(user.id);
  if (!credential) {
    await verifyPassword(await timingEqualisationHash(), input.password);
    await writeAuditSafe(failedLoginAudit(email, user.id, meta));
    throw new UnauthenticatedError(GENERIC_LOGIN_FAILURE);
  }

  if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) {
    throw new AccountLockedError();
  }

  const passwordValid = await verifyPassword(credential.passwordHash, input.password);
  if (!passwordValid) {
    await recordFailedAttempt(user.id, {
      maxAttempts: config.LOGIN_MAX_FAILED_ATTEMPTS,
      lockMinutes: config.LOGIN_LOCKOUT_MINUTES,
    });
    await writeAuditSafe(failedLoginAudit(email, user.id, meta));
    throw new UnauthenticatedError(GENERIC_LOGIN_FAILURE);
  }

  // Deactivated identity: same generic failure, so deactivation is not inferable from a
  // login attempt (docs/06 §3).
  if (user.status !== 'ACTIVE') {
    await writeAuditSafe(failedLoginAudit(email, user.id, meta));
    throw new UnauthenticatedError(GENERIC_LOGIN_FAILURE);
  }

  await clearFailedAttempts(user.id);

  const window = newSessionWindow();
  const sessionToken = randomToken(32);
  const csrfToken = randomToken(24);

  await runInTransaction(async (tx: TxClient) => {
    await createSession(
      {
        userId: user.id,
        tokenHash: sha256(sessionToken),
        csrfSecretHash: sha256(csrfToken),
        idleExpiresAt: window.idleExpiresAt,
        absoluteExpiresAt: window.absoluteExpiresAt,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: user.organizationId,
        actorId: user.id,
        actorType: 'USER',
        action: AUDIT_ACTION.LOGIN_SUCCESS,
        entityType: AUDIT_ENTITY.SESSION,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  const permissions = await resolvePermissionKeys(user.id);

  return {
    sessionToken,
    csrfToken,
    expiresAt: window.absoluteExpiresAt,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      organizationId: user.organizationId,
      isPlatformOperator: user.organizationId === null,
    },
    permissions: [...permissions].sort(),
  };
}

/**
 * Resolves the caller of a request from the session cookie.
 *
 * Returns null (not an error) for an unknown/expired/revoked session so the middleware
 * can decide the response; a service this low should not throw a transport-shaped error
 * for a normal "no session" outcome.
 */
export async function resolveSession(token: string): Promise<{
  actor: Principal;
  sessionId: string;
  csrfSecretHash: string | null;
} | null> {
  const tokenHash = sha256(token);

  // Shared Redis lookup first (ADR-0001); the database is the durable fallback and the
  // source of truth, so a cache flush never resurrects a revoked session (docs/33 C4).
  let session = await readCachedSession(tokenHash);
  if (!session) {
    session = await findSessionByTokenHash(tokenHash);
    if (!session) {
      return null;
    }
  }

  if (isSessionExpired(session)) {
    return null;
  }
  if (session.user.status !== 'ACTIVE') {
    return null;
  }

  // Sliding idle window, capped at the absolute expiry (docs/06 §7).
  const now = new Date();
  const idleExpiresAt = refreshedIdleExpiry(session.absoluteExpiresAt, now);
  await touchSession(session.id, { lastSeenAt: now, idleExpiresAt });

  // Refresh the cached copy so the slid idle window is what the next request sees;
  // otherwise an active user would eventually be timed out against a stale window.
  await writeCachedSession({ ...session, lastSeenAt: now, idleExpiresAt });

  const permissions = await resolvePermissionKeys(session.userId);

  return {
    sessionId: session.id,
    csrfSecretHash: session.csrfSecretHash,
    actor: {
      userId: session.userId,
      organizationId: session.user.organizationId,
      isActive: session.user.status === 'ACTIVE',
      permissions,
    },
  };
}

/**
 * The identity view returned by `GET /auth/me` (docs/11 §9).
 *
 * Deliberately narrow: it exposes who the caller is and which tenant they belong to,
 * never the credential or session material. Effective permissions are attached by the
 * caller from the request principal so they reflect the live database state.
 */
export async function getIdentity(userId: string): Promise<{
  id: string;
  email: string;
  displayName: string;
  organizationId: string | null;
  isPlatformOperator: boolean;
  status: string;
} | null> {
  const user = await findUserById(userId);
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    organizationId: user.organizationId,
    isPlatformOperator: user.organizationId === null,
    status: user.status,
  };
}

/** Server-side session revocation (docs/06 §7): logout is immediate, not a client hint. */
export async function logout(
  sessionId: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<void> {
  let revokedTokenHash: string | null = null;

  await runInTransaction(async (tx) => {
    const revoked = await revokeSession(sessionId, tx);
    revokedTokenHash = revoked.tokenHash;
    await writeAudit(
      {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.LOGOUT,
        entityType: AUDIT_ENTITY.SESSION,
        entityId: sessionId,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  // Invalidate the shared cache after the durable revocation commits (docs/33 C3).
  if (revokedTokenHash) {
    await invalidateSessionCache(revokedTokenHash);
  }
}

/**
 * Requests a password reset. Always succeeds, whether or not the address exists
 * (docs/06 §5): a differing response would confirm account existence.
 *
 * Prisma's PrismaClient or a transaction client both satisfy the model signatures, so
 * the reads here are plain; the writes share one transaction.
 */
export async function requestPasswordReset(
  input: { email: string },
  meta: RequestMeta,
): Promise<void> {
  const user = await findUserByEmail(normalizeEmail(input.email));
  if (!user || user.status !== 'ACTIVE') {
    return;
  }

  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + 60 * 60_000);

  await runInTransaction(async (tx) => {
    await invalidateOutstandingResets(user.id, tx);
    await createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }, tx);
    await writeOutboxEvent(
      {
        organizationId: user.organizationId,
        eventType: OUTBOX_EVENT.PASSWORD_RESET_REQUESTED,
        payload: {
          email: user.email,
          resetUrl: `${config.APP_BASE_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`,
          expiresAt: expiresAt.toISOString(),
        },
        idempotencyKey: `password-reset:${user.id}:${tokenHash.slice(0, 32)}`,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: user.organizationId,
        actorId: user.id,
        actorType: 'USER',
        action: AUDIT_ACTION.PASSWORD_RESET_REQUESTED,
        entityType: AUDIT_ENTITY.USER,
        entityId: user.id,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });
}

/**
 * Completes a password reset (docs/06 §5): single-use token, policy check, and every
 * existing session revoked so a silent takeover cannot proceed on a live session.
 */
export async function resetPassword(
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<void> {
  const invalid = (): ValidationError =>
    new ValidationError([
      {
        field: 'token',
        code: 'INVALID_RESET_TOKEN',
        message: 'This reset link is invalid, expired, or has already been used.',
      },
    ]);

  const reset = await findPasswordResetByTokenHash(sha256(input.token));
  if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) {
    throw invalid();
  }

  const user = await findUserById(reset.userId);
  if (!user || user.status !== 'ACTIVE') {
    throw invalid();
  }

  const policyProblems = validatePasswordPolicy(input.password, {
    email: user.email,
    displayName: user.displayName,
  });
  if (policyProblems.length > 0) {
    throw new ValidationError(policyProblems);
  }

  const passwordHash = await hashPassword(input.password);

  // Capture the live session digests before revoking, so their cache entries can be
  // invalidated once the revocation is durable (docs/33 C3).
  const liveSessionTokenHashes = await listLiveSessionTokenHashes(user.id);

  await runInTransaction(async (tx) => {
    await upsertCredential({ userId: user.id, passwordHash }, tx);
    await markPasswordResetUsed(reset.id, tx);
    await invalidateOutstandingResets(user.id, tx);
    await revokeAllSessionsForUser(user.id, tx);
    await writeAudit(
      {
        organizationId: user.organizationId,
        actorId: user.id,
        actorType: 'USER',
        action: AUDIT_ACTION.PASSWORD_RESET,
        entityType: AUDIT_ENTITY.USER,
        entityId: user.id,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  await invalidateSessionCaches(liveSessionTokenHashes);
}

/** Creates the first credential for an identity via the invitation flow (used by tests). */
export async function setInitialCredential(userId: string, password: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) {
    throw new ValidationError([
      { field: 'userId', code: 'NOT_FOUND', message: 'User does not exist.' },
    ]);
  }
  const problems = validatePasswordPolicy(password, { email: user.email });
  if (problems.length > 0) {
    throw new ValidationError(problems);
  }
  await createCredential({ userId, passwordHash: await hashPassword(password) });
}

function failedLoginAudit(email: string, actorId: string | null, meta: RequestMeta) {
  return {
    organizationId: null,
    actorId,
    actorType: 'USER' as const,
    action: AUDIT_ACTION.LOGIN_FAILURE,
    entityType: AUDIT_ENTITY.USER,
    entityId: actorId,
    after: { email },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp ?? null,
    userAgent: meta.userAgent ?? null,
  };
}
