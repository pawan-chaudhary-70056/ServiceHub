import type { Attachment, AttachmentStatus } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Attachment data access — docs/19 §7, docs/08 §3.
 *
 * The row is metadata only: bytes live in object storage (`ADR-0004`) behind a
 * server-generated key. Three rules belong here rather than in the service:
 *
 *   - The parent lookup is `(entityType, entityId)` with `organizationId` in the same
 *     predicate (index Q11, docs/09) — a query that could return another tenant's rows
 *     is the failure this shape makes impossible (ADR-0002).
 *   - **Status filtering happens in the query** for listing: a PENDING or QUARANTINED row
 *     is never part of a response body (docs/19 §7.2 rule 1).
 *   - The per-record cap is counted inside the caller's transaction, so a burst of
 *     concurrent uploads cannot slip past limit (docs/19 §7.4: 20 per record).
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export interface AttachmentWithUploader extends Attachment {
  uploader: { id: string; displayName: string };
}

export function createAttachment(
  data: {
    organizationId: string;
    entityType: string;
    entityId: string;
    uploaderId: string;
    filename: string;
    storageKey: string;
    contentType: string;
    sizeBytes: number;
    status: AttachmentStatus;
  },
  client: DataClient = prisma,
): Promise<Attachment> {
  return client.attachment.create({ data });
}

export function findAttachmentById(
  id: string,
  client: DataClient = prisma,
): Promise<AttachmentWithUploader | null> {
  return client.attachment.findUnique({
    where: { id },
    include: { uploader: { select: { id: true, displayName: true } } },
  });
}

/**
 * Counted inside the upload transaction — the cap is a rule about a moment in time, so
 * reading it outside the write would be a check-then-act race (docs/09 §4).
 */
export function countAttachmentsForParent(
  params: { organizationId: string; entityType: string; entityId: string },
  client: DataClient = prisma,
): Promise<number> {
  return client.attachment.count({
    where: {
      organizationId: params.organizationId,
      entityType: params.entityType,
      entityId: params.entityId,
    },
  });
}

/** A parent's attachments, newest first. Bounded by the per-record cap (docs/19 §7.4). */
export function listAttachmentsForParent(
  params: { organizationId: string; entityType: string; entityId: string },
  client: DataClient = prisma,
): Promise<AttachmentWithUploader[]> {
  return client.attachment.findMany({
    where: {
      organizationId: params.organizationId,
      entityType: params.entityType,
      entityId: params.entityId,
      status: 'AVAILABLE',
    },
    include: { uploader: { select: { id: true, displayName: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 101,
  });
}

/**
 * Attachments still awaiting the scan step, oldest first (`docs/19` §7.2 step 7).
 *
 * Oldest first, so the queue cannot starve: a steady upload rate with a newest-first order
 * would leave the earliest uploads permanently unscanned.
 */
export function listPendingAttachments(
  limit: number,
  client: DataClient = prisma,
): Promise<Attachment[]> {
  return client.attachment.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

/** Status transition of the scan step (docs/19 §7.2 rules 1). */
export function setAttachmentStatus(
  id: string,
  status: AttachmentStatus,
  client: DataClient = prisma,
): Promise<Attachment> {
  return client.attachment.update({
    where: { id },
    data: status === 'QUARANTINED' ? { status, quarantinedAt: new Date() } : { status },
  });
}

export function deleteAttachment(id: string, client: DataClient = prisma): Promise<Attachment> {
  return client.attachment.delete({ where: { id } });
}
