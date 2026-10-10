/**
 * Operator password reset — the recovery path for a platform operator (docs/10 §8, docs/06 §4/§6).
 *
 * Why this exists as a committed command rather than an ad-hoc script: the bootstrap
 * (`bootstrap-platform-operator.ts`) is deliberately **guarded** — it refuses once an operator
 * exists, because a second operator is a deliberate act, not a retry. That leaves no supported
 * way to recover the *first* operator if its password is lost, and inventing one at the console
 * under time pressure is how a superadmin credential ends up shared in a chat message. So the
 * recovery is a tool with the same discipline as the bootstrap:
 *
 *   - **No default or invented password.** It reads `OPERATOR_NEW_PASSWORD` from the
 *     environment and refuses if it is absent.
 *   - **The real policy, not a copy.** Validation and hashing come from the application's own
 *     helpers (`validatePasswordPolicy`, `hashPassword`), so the reset cannot drift from what
 *     login accepts and from the configured Argon2id parameters.
 *   - **It refuses ambiguity.** With no `OPERATOR_EMAIL` and more than one platform operator it
 *     stops and lists them rather than picking one.
 *   - **It is audited, in the same transaction as the change** (docs/31 §3.1), with
 *     `actorType: SYSTEM` and a reason that names this command — an operator-driven credential
 *     change is exactly the event a security review needs to see.
 *   - **It revokes every live session for the account** (docs/06 §7): a password reset that
 *     leaves an attacker's session alive has not reset anything.
 *
 * It never prints the password. Whoever supplied it already has it, and a tool that echoes a
 * credential is a tool that puts one in a shell history.
 *
 * Usage:
 *   OPERATOR_NEW_PASSWORD='...' npm run operator:reset-password
 *   OPERATOR_NEW_PASSWORD='...' OPERATOR_EMAIL=root@servicehub.local npm run operator:reset-password
 */

// Same first-import rule as the entrypoints: populate the environment from a local
// `backend/.env` (when present) before anything that validates configuration is loaded.
import '../src/config/load-env';
import { PLATFORM_ROLE_KEY } from '../src/helpers/permission-catalogue';

async function main(): Promise<void> {
  // Imported after the environment is populated: `src/config` validates at import time and
  // fails fast, which is the behaviour we want here too (docs/35 §2).
  const {
    prisma,
    runInTransaction,
    upsertCredential,
    revokeAllSessionsForUser,
    listLiveSessionTokenHashes,
    writeAudit,
  } = await import('../src/models');
  const { hashPassword } = await import('../src/helpers/crypto');
  const { validatePasswordPolicy } = await import('../src/helpers/password');
  const { invalidateSessionCaches } = await import('../src/services/session-cache');
  const { AUDIT_ACTION, AUDIT_ENTITY } = await import('../src/services/audit-events');

  const newPassword = process.env.OPERATOR_NEW_PASSWORD;
  const requestedEmail = process.env.OPERATOR_EMAIL?.trim().toLowerCase();

  try {
    const operators = await prisma.user.findMany({
      where: { organizationId: null, status: 'ACTIVE' },
      select: { id: true, email: true, displayName: true },
      orderBy: { createdAt: 'asc' },
    });

    if (operators.length === 0) {
      throw new Error(
        'No active platform operator exists. Create the first one with: npm run bootstrap:operator',
      );
    }

    const target = requestedEmail
      ? operators.find((operator) => operator.email === requestedEmail)
      : operators.length === 1
        ? operators[0]
        : undefined;

    if (!target) {
      const known = operators.map((operator) => operator.email).join(', ');
      throw new Error(
        requestedEmail
          ? `No active platform operator has the email ${requestedEmail}. Known operators: ${known}`
          : `More than one platform operator exists; set OPERATOR_EMAIL to choose one. Known operators: ${known}`,
      );
    }

    if (!newPassword) {
      throw new Error('OPERATOR_NEW_PASSWORD is required (no default credential is permitted).');
    }

    const problems = validatePasswordPolicy(newPassword, {
      email: target.email,
      displayName: target.displayName,
    });
    if (problems.length > 0) {
      throw new Error(
        `The new password does not satisfy the policy (docs/06 §4):\n${problems
          .map((problem) => `  - ${problem.message}`)
          .join('\n')}`,
      );
    }

    const passwordHash = await hashPassword(newPassword);

    // Read the live session digests before revoking, so their cache entries can be invalidated
    // once the revocation is durable (docs/33 C3) — the same order `auth.service` uses.
    const liveSessionTokenHashes = await listLiveSessionTokenHashes(target.id);
    const revoked = liveSessionTokenHashes.length;

    await runInTransaction(async (tx) => {
      await upsertCredential({ userId: target.id, passwordHash }, tx);
      await revokeAllSessionsForUser(target.id, tx);
      await writeAudit(
        {
          organizationId: null,
          actorId: null,
          actorType: 'SYSTEM',
          action: AUDIT_ACTION.PASSWORD_RESET,
          entityType: AUDIT_ENTITY.USER,
          entityId: target.id,
          after: { email: target.email, sessionsRevoked: revoked, via: 'operator-reset-command' },
          correlationId: 'reset-operator-password',
          sourceIp: null,
          userAgent: null,
        },
        tx,
      );
    });

    await invalidateSessionCaches(liveSessionTokenHashes);

    process.stdout.write(
      `Password reset for platform operator ${target.email} ` +
        `(role ${PLATFORM_ROLE_KEY}, ${revoked} session(s) revoked, change audited).\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
