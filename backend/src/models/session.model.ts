import type { Prisma, Session } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Server-side session queries — `ADR-0001`, docs/06 §7.
 *
 * The `sessions` row is the durable, revocable record. The raw token is never stored,
 * only its SHA-256 digest (`tokenHash`), so a database read cannot yield a usable
 * session. Lookup is by that digest; validation of the two expiry clocks happens in the
 * service (`helpers/session.ts`), keeping this module a thin data layer.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

/** A session joined to the identity and organization scope it authenticates. */
export type SessionWithUser = Prisma.SessionGetPayload<{
  include: { user: true };
}>;

export function createSession(
  data: {
    userId: string;
    tokenHash: string;
    csrfSecretHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    sourceIp?: string | null;
    userAgent?: string | null;
  },
  client: DataClient = prisma,
): Promise<Session> {
  return client.session.create({ data });
}

/** Loads a session and its user by token digest. Revocation/expiry is checked by the caller. */
export function findSessionByTokenHash(
  tokenHash: string,
  client: DataClient = prisma,
): Promise<SessionWithUser | null> {
  return client.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
}

/** Extends the idle window after a request (never past the absolute ceiling). */
export function touchSession(
  id: string,
  data: { lastSeenAt: Date; idleExpiresAt: Date },
  client: DataClient = prisma,
): Promise<Session> {
  return client.session.update({ where: { id }, data });
}

export function revokeSession(id: string, client: DataClient = prisma): Promise<Session> {
  return client.session.update({ where: { id }, data: { revokedAt: new Date() } });
}

/**
 * The token digests of a user's live sessions.
 *
 * Read immediately before a bulk revocation so the cache entries for those sessions can
 * be invalidated too (docs/33 C3). The digest is not a credential — it cannot be
 * reversed to a usable token — so it is safe to surface to the cache layer.
 */
export async function listLiveSessionTokenHashes(
  userId: string,
  client: DataClient = prisma,
): Promise<string[]> {
  const rows = await client.session.findMany({
    where: { userId, revokedAt: null },
    select: { tokenHash: true },
  });
  return rows.map((row) => row.tokenHash);
}

/**
 * Revokes every live session for a user.
 *
 * Used on password change/reset and deactivation, where docs/06 §7 requires existing
 * sessions to die immediately rather than waiting for expiry.
 */
export function revokeAllSessionsForUser(
  userId: string,
  client: DataClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
