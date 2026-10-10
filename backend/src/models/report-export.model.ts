import type { Prisma, ReportExport } from '@prisma/client';
import { prisma, type DataClient } from './db';

/** Re-exported so services can name the row type without importing Prisma directly. */
export type { ReportExport };

/**
 * Report export persistence (`docs/30` §3.1/§3.4, F-14).
 *
 * An export is an async job: it is queued, run by a worker, and its result is a
 * **time-limited** download. The filters are recorded on the export itself (`§3.2` R5), so
 * an export can be re-derived and audited. Only `services/` may import this module.
 */

export interface CreateReportExportInput {
  organizationId: string;
  requestedById: string;
  metric: string;
  params: Prisma.InputJsonValue;
  format: string;
}

export function createReportExport(
  input: CreateReportExportInput,
  client: DataClient = prisma,
): Promise<ReportExport> {
  return client.reportExport.create({ data: input });
}

export function findReportExportById(
  id: string,
  client: DataClient = prisma,
): Promise<ReportExport | null> {
  return client.reportExport.findUnique({ where: { id } });
}

export function listQueuedReportExports(limit: number, client: DataClient = prisma) {
  return client.reportExport.findMany({
    where: { status: 'QUEUED' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

/**
 * Claims a queued export for this worker. The conditional update makes the claim atomic, so
 * two workers racing the same row cannot both run it (docs/09 §7 locking).
 */
export async function claimReportExport(id: string, client: DataClient = prisma): Promise<boolean> {
  const result = await client.reportExport.updateMany({
    where: { id, status: 'QUEUED' },
    data: { status: 'RUNNING' },
  });
  return result.count > 0;
}

/**
 * Records a completed export. The CSV's **bytes are already in object storage**; only its key
 * is persisted (`ADR-0004`, `19` §7.1), so completing a job never writes file content to the
 * database.
 */
export function markReportExportSucceeded(
  id: string,
  input: { storageKey: string; rowCount: number; expiresAt: Date },
  client: DataClient = prisma,
): Promise<ReportExport> {
  return client.reportExport.update({
    where: { id },
    data: {
      status: 'SUCCEEDED',
      storageKey: input.storageKey,
      rowCount: input.rowCount,
      expiresAt: input.expiresAt,
      completedAt: new Date(),
      error: null,
    },
  });
}

export function markReportExportFailed(
  id: string,
  error: string,
  client: DataClient = prisma,
): Promise<ReportExport> {
  return client.reportExport.update({
    where: { id },
    data: { status: 'FAILED', error, completedAt: new Date() },
  });
}
