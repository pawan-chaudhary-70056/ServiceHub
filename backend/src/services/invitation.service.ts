import { config } from '../config';
import { randomToken, sha256, hashPassword } from '../helpers/crypto';
import { validatePasswordPolicy } from '../helpers/password';
import { ValidationError } from '../utils/errors';
import type { TxClient } from '../models';
import {
  createInvitation,
  findInvitationByTokenHash,
  findOrganizationById,
  findUserByEmail,
  invalidateOutstandingInvitations,
  markInvitationAccepted,
  runInTransaction,
  setUserStatus,
  upsertCredential,
  writeAudit,
  writeOutboxEvent,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Invitation lifecycle — docs/06 §11, docs/04 §13.3, `ADR-0012`.
 *
 * The distinction that matters: an invitation **establishes a first credential**; a
 * password reset **replaces one** (docs/06 §11 rule 6). Conflating them produces a
 * self-service account-creation path, which is why the two token tables are separate.
 */

export interface IssuedInvitation {
  invitationId: string;
  email: string;
  expiresAt: Date;
  /** Raw token. Returned so a non-production environment can render the link; never stored. */
  token: string;
}

const INVITATION_TTL_MS = config.INVITATION_TTL_HOURS * 3_600_000;

/** The link a user follows to set their first credential. Grants no authority by itself. */
export function invitationAcceptUrl(token: string): string {
  const base = config.APP_BASE_URL.replace(/\/$/, '');
  return `${base}/accept-invitation?token=${encodeURIComponent(token)}`;
}

/**
 * Issues an invitation inside the caller's transaction.
 *
 * Persisting the invitation, superseding any prior outstanding token, the audit record
 * and the outbox event all share the transaction, so an invitation can never exist
 * without its supersession or its queued email (docs/04 §13.4).
 *
 * `tx` is required rather than optional: callers (provisioning, tenant invite) already
 * have an open transaction, and defaulting to the root client would silently break the
 * "one transaction" invariant.
 */
export async function issueInvitation(
  tx: TxClient,
  params: {
    organizationId: string;
    email: string;
    roleId: string;
    invitedById: string;
    meta: RequestMeta;
  },
): Promise<IssuedInvitation> {
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await createInvitation(
    {
      organizationId: params.organizationId,
      email: params.email,
      roleId: params.roleId,
      tokenHash,
      invitedById: params.invitedById,
      expiresAt,
    },
    tx,
  );

  // Rule 2 (docs/06 §11): a new invite invalidates any outstanding token for the same
  // address, so only the most recent email can be used.
  await invalidateOutstandingInvitations(
    { organizationId: params.organizationId, email: params.email, exceptId: invitation.id },
    tx,
  );

  await writeAudit(
    {
      organizationId: params.organizationId,
      actorId: params.invitedById,
      actorType: 'USER',
      action: AUDIT_ACTION.USER_INVITED,
      entityType: AUDIT_ENTITY.INVITATION,
      entityId: invitation.id,
      after: { email: params.email, roleId: params.roleId, expiresAt: expiresAt.toISOString() },
      correlationId: params.meta.correlationId,
      sourceIp: params.meta.sourceIp ?? null,
      userAgent: params.meta.userAgent ?? null,
    },
    tx,
  );

  // Queued, never sent inline (docs/29 §3). The idempotency key makes a redelivery a
  // no-op rather than a second email.
  await writeOutboxEvent(
    {
      organizationId: params.organizationId,
      eventType: OUTBOX_EVENT.INVITATION_CREATED,
      payload: {
        invitationId: invitation.id,
        email: params.email,
        acceptUrl: invitationAcceptUrl(token),
        expiresAt: expiresAt.toISOString(),
      },
      idempotencyKey: `invitation:${invitation.id}`,
    },
    tx,
  );

  return { invitationId: invitation.id, email: params.email, expiresAt, token };
}

/**
 * Accepts an invitation and activates the identity (docs/06 §11).
 *
 * Every rejection returns the SAME `422` field error, so a caller cannot distinguish an
 * unknown token from an expired or already-used one — that difference would let someone
 * probe which addresses have a pending invite (docs/06 §9, docs/17).
 */
export async function acceptInvitation(
  input: { token: string; password: string; displayName?: string },
  meta: RequestMeta,
): Promise<void> {
  const invalid = (): ValidationError =>
    new ValidationError([
      {
        field: 'token',
        code: 'INVALID_INVITATION',
        message: 'This invitation is invalid, expired, or has already been used.',
      },
    ]);

  const tokenHash = sha256(input.token);
  const invitation = await findInvitationByTokenHash(tokenHash);

  if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() <= Date.now()) {
    throw invalid();
  }

  const organization = await findOrganizationById(invitation.organizationId);
  if (!organization || organization.status !== 'ACTIVE') {
    throw invalid();
  }

  const user = await findUserByEmail(invitation.email);
  // The identity is created with the invitation; a mismatch means a stale or forged token.
  if (!user || user.organizationId !== invitation.organizationId) {
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

  await runInTransaction(async (tx) => {
    await upsertCredential({ userId: user.id, passwordHash }, tx);
    await setUserStatus(user.id, 'ACTIVE', tx);
    await markInvitationAccepted(invitation.id, user.id, tx);
    // Any other outstanding invitations for this address are now moot.
    await invalidateOutstandingInvitations(
      {
        organizationId: invitation.organizationId,
        email: invitation.email,
        exceptId: invitation.id,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: invitation.organizationId,
        actorId: user.id,
        actorType: 'USER',
        action: AUDIT_ACTION.USER_ACTIVATED,
        entityType: AUDIT_ENTITY.USER,
        entityId: user.id,
        after: { status: 'ACTIVE' },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });
}
