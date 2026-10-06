import type { PasswordResetToken } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Password-reset token queries — docs/06 §5.
 *
 * Distinct from an invitation: a reset **replaces** an existing credential; an
 * invitation establishes a first one (docs/06 §11 rule 6). Tokens are single-use,
 * hashed at rest, and expiry-bounded.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export function createPasswordResetToken(
  data: { userId: string; tokenHash: string; expiresAt: Date },
  client: DataClient = prisma,
): Promise<PasswordResetToken> {
  return client.passwordResetToken.create({ data });
}

export function findPasswordResetByTokenHash(
  tokenHash: string,
  client: DataClient = prisma,
): Promise<PasswordResetToken | null> {
  return client.passwordResetToken.findUnique({ where: { tokenHash } });
}

export function markPasswordResetUsed(
  id: string,
  client: DataClient = prisma,
): Promise<PasswordResetToken> {
  return client.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } });
}

/** Invalidates outstanding reset tokens for a user (on use, or on a new request). */
export function invalidateOutstandingResets(
  userId: string,
  client: DataClient = prisma,
): Promise<{ count: number }> {
  return client.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}
