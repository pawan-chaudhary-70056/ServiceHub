import { PrismaClient } from '@prisma/client';
// Load a local `backend/.env` (when present) so `npm run prisma:seed` works the way
// `npx prisma migrate` does, without every variable being exported by hand. A deployed
// environment has no `.env` and an injected environment always wins (`config/load-env.ts`).
import '../src/config/load-env';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';

/**
 * Reference-data seed (docs/10 §8).
 *
 * Idempotent and keyed on a stable natural key, so re-running is safe and adding a
 * permission does not duplicate existing ones. Contains **no demo data and no
 * credentials** — a fixture script is a separate artefact, and production is never
 * seeded with users (docs/10 §8).
 *
 * Tenant roles are NOT seeded here: they are seeded per organization at provisioning
 * (docs/04 §13.2), so each tenant can adjust its own grants. The tenant role matrix is
 * exported from `src/helpers/permission-catalogue.ts` for that step.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: {
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
      create: permission,
    });
  }

  for (const role of PLATFORM_ROLES) {
    // A platform role has a null organizationId, and Prisma cannot use a compound
    // unique containing null as an upsert `where`, so find-then-write is used.
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, key: role.key },
    });
    const row = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: role.name, description: role.description, isSystem: true },
        })
      : await prisma.role.create({
          data: {
            organizationId: null,
            key: role.key,
            name: role.name,
            description: role.description,
            isSystem: true,
          },
        });

    for (const key of role.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: row.id, permissionId: permission.id } },
        update: {},
        create: { roleId: row.id, permissionId: permission.id },
      });
    }
  }

  process.stdout.write(
    `Seed complete: ${PERMISSIONS.length} permissions, ${PLATFORM_ROLES.length} platform role(s).\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
