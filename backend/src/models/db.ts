import { PrismaClient, type Prisma } from '@prisma/client';
import { config, isProduction } from '../config';
import { logger } from '../utils/logger';

/**
 * The single Prisma client and transaction entry point.
 *
 * Kept in its own module so entity modules can import the client without creating a
 * cycle through the barrel (`./index`). Only `services/` may reach this layer
 * (docs/03 §4, enforced in `eslint.config.mjs`).
 *
 * One client per process: Prisma already pools connections, and a client per request
 * exhausts the database's connection budget — the first thing to break under load
 * (docs/33 §2).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Query logs stay off: they echo parameters and are a data-leak and noise risk
    // (docs/34 L1). Warnings and errors are always surfaced.
    log: ['warn', 'error'],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/** A transaction-scoped client, as passed to `prisma.$transaction(async (tx) => …)`. */
export type TxClient = Prisma.TransactionClient;

/** A client that may be either the root client or a transaction client. */
export type DataClient = PrismaClient | TxClient;

/**
 * Runs multi-write work in one transaction (docs/04 §2.3).
 *
 * The audit record is written with the mutation inside this callback, so a rolled-back
 * mutation cannot leave an audit record and a committed one cannot skip it (docs/31).
 */
export function runInTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}

/**
 * Cheap liveness/readiness probe for the database.
 *
 * Used by readiness only — never by liveness, because a database blip must not restart
 * healthy instances (docs/34 §6).
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Database readiness probe failed');
    return false;
  }
}

/** Called on graceful shutdown so in-flight queries finish and connections release. */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export const isDatabaseConfigured = (): boolean => config.DATABASE_URL.length > 0;
