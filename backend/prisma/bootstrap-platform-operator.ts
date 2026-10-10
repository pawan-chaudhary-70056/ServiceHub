import argon2 from 'argon2';
import { ActorType, PrismaClient, UserStatus } from '@prisma/client';
// Load a local `backend/.env` (when present) so the command reads DATABASE_URL the way
// `npx prisma migrate` does. An injected environment always wins (`config/load-env.ts`).
import '../src/config/load-env';
import { PLATFORM_ROLE_KEY } from '../src/helpers/permission-catalogue';

/**
 * Admin bootstrap: create the FIRST platform operator (Super Admin).
 *
 * Rules (docs/10 §8, docs/04 §13.1, ADR-0012):
 *   - GUARDED: if a platform operator already exists, it refuses and exits 0, so it is
 *     safe to re-run (it is not idempotent by upsert — a second operator is a deliberate
 *     act, not a retry).
 *   - NO default or hard-coded password: the credential comes from the environment.
 *   - The event is AUDITED (actor type SYSTEM, action `platform.bootstrap`).
 *
 * Run after the seed:  npm run bootstrap:operator
 */
const prisma = new PrismaClient();

/** Argon2id floors from docs/06 §4 (kept local so the CLI need not load full config). */
const ARGON2 = {
  memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? 65_536),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
  parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
};

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_OPERATOR_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_OPERATOR_PASSWORD;
  const displayName = process.env.BOOTSTRAP_OPERATOR_NAME?.trim() ?? 'Platform Operator';

  const existing = await prisma.user.findFirst({ where: { organizationId: null } });
  if (existing) {
    process.stdout.write(
      'A platform operator already exists; bootstrap is a guarded no-op (docs/10 §8).\n',
    );
    return;
  }

  if (!email || !password) {
    throw new Error(
      'BOOTSTRAP_OPERATOR_EMAIL and BOOTSTRAP_OPERATOR_PASSWORD are required (no default credential is permitted).',
    );
  }
  if (password.length < 12) {
    throw new Error('The bootstrap password must be at least 12 characters (docs/06 §4).');
  }

  const role = await prisma.role.findFirst({
    where: { organizationId: null, key: PLATFORM_ROLE_KEY },
  });
  if (!role) {
    throw new Error('Platform role not found — run the seed first: npm run prisma:seed');
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: ARGON2.memoryCost,
    timeCost: ARGON2.timeCost,
    parallelism: ARGON2.parallelism,
  });

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        organizationId: null,
        email,
        displayName,
        status: UserStatus.ACTIVE,
        credential: { create: { passwordHash } },
      },
    });

    await tx.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId: null },
    });

    await tx.auditLog.create({
      data: {
        organizationId: null,
        actorType: ActorType.SYSTEM,
        action: 'platform.bootstrap',
        entityType: 'User',
        entityId: user.id,
        correlationId: 'bootstrap-platform-operator',
        after: { email, role: role.key },
      },
    });
  });

  process.stdout.write(`Platform operator ${email} created (audited).\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`Bootstrap failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
