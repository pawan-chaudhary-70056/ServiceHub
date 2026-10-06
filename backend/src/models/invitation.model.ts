import type { Invitation } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Invitation queries — docs/06 §11, docs/04 §13.3, `ADR-0012`.
 *
 * An invitation establishes a **first** credential (unlike a password reset, which
 * replaces one). The raw token is never stored, only its digest. State changes
 * (acceptance, supersession) are explicit so the single-use and
 * re-invite-invalidates-prior rules are visible in one place.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export function createInvitation(
  data: {
    organizationId: string;
    email: string;
    roleId: string;
    tokenHash: string;
    invitedById: string;
    expiresAt: Date;
  },
  client: DataClient = prisma,
): Promise<Invitation> {
  return client.invitation.create({ data });
}

export function findInvitationByTokenHash(
  tokenHash: string,
  client: DataClient = prisma,
): Promise<Invitation | null> {
  return client.invitation.findUnique({ where: { tokenHash } });
}

export function markInvitationAccepted(
  id: string,
  acceptedById: string,
  client: DataClient = prisma,
): Promise<Invitation> {
  return client.invitation.update({
    where: { id },
    data: { acceptedAt: new Date(), acceptedById },
  });
}

/**
 * Supersedes every outstanding invitation for an address in a tenant
 * (docs/06 §11 rule 2: "re-inviting … invalidates any outstanding token").
 *
 * Acceptance is recorded as a timestamp, not a soft-delete, and supersession is applied
 * by expiring the window, so the trail of what was issued remains queryable by audit.
 */
export function invalidateOutstandingInvitations(
  params: { organizationId: string; email: string; exceptId?: string },
  client: DataClient = prisma,
): Promise<{ count: number }> {
  return client.invitation.updateMany({
    where: {
      organizationId: params.organizationId,
      email: params.email,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
      ...(params.exceptId ? { id: { not: params.exceptId } } : {}),
    },
    data: { expiresAt: new Date() },
  });
}

export function listInvitationsForOrganization(
  organizationId: string,
  client: DataClient = prisma,
): Promise<Invitation[]> {
  return client.invitation.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
}
