import type { Readable } from 'node:stream';
import type { Attachment } from '@prisma/client';
import { config } from '../config';
import { hasPermission, type Principal } from '../helpers/authorization';
import {
  canonicalContentType,
  contentDisposition,
  sanitizeFilename,
  scanUpload,
} from '../helpers/file-sniff';
import { fileStorage, newStorageKey } from '../integrations/storage';
import {
  countAttachmentsForParent,
  createAttachment,
  findAttachmentById,
  listAttachmentsForParent,
  runInTransaction,
  setAttachmentStatus,
  writeAudit,
  type AttachmentWithUploader,
} from '../models';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';
import { assertArticleVisible } from './kb.service';
import { assertIncidentVisible } from './incident.service';
import { assertRequestVisible } from './request.service';

/**
 * File attachments — docs/19 §7, F-16 (`FR-FILE-001`).
 *
 * This service is where the file pipeline's load-bearing rules live, and each one is a
 * defect that leaks data or stores malware if it slips:
 *
 *   1. **Attachments are never more visible than their parent** (`07` §4). There is no
 *      attachment read permission: every operation — list, upload, download — resolves
 *      the parent through the owning service's own object-level check, and an invisible
 *      parent is `404`, never `403`.
 *   2. **Authorization is re-checked on every download** (`19` §7.3), not just at
 *      upload, so losing access to the record loses access to its files.
 *   3. **Nothing is retrievable before it clears the scan step**, and a quarantined file
 *      is never served — the status gate sits in front of both the stream and the
 *      signed URL, so there is no second path around it.
 *   4. **Size is bounded before the body is read** (`19` §7.2 rule 4) and the per-record
 *      count is checked inside the write transaction, not around it.
 *   5. **External storage I/O never runs inside a transaction** (`33` §11): metadata is
 *      written, then the bytes are stored, then the row is promoted. The worst
 *      interruption leaves a PENDING row that no response can serve.
 *
 * Downloads are audited (`19` §7.3): an attachment is classified Confidential, so a
 * disclosure is always a recorded event.
 */

/** The record types a file may hang off (`FR-FILE-001`: requests, incidents, KB). */
export type AttachmentParentType = 'ServiceRequest' | 'Incident' | 'Article';

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: 'PENDING' | 'AVAILABLE' | 'QUARANTINED';
  uploadedBy: { id: string; displayName: string };
  createdAt: string;
  /** Relative URL; the download itself re-checks the parent (`19` §7.3). */
  downloadUrl: string;
}

/** Where a download's bytes come from once authorisation has passed. */
export type DownloadTarget =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'stream';
      stream: Readable;
      contentType: string;
      filename: string;
      disposition: string;
    };

function toView(row: AttachmentWithUploader): AttachmentView {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    uploadedBy: { id: row.uploader.id, displayName: row.uploader.displayName },
    createdAt: row.createdAt.toISOString(),
    downloadUrl: `/api/v1/attachments/${row.id}/content`,
  };
}

// ---------------------------------------------------------------------------
// Parent resolution — the authorization backbone
// ---------------------------------------------------------------------------

interface ParentContext {
  organizationId: string;
  entityType: AttachmentParentType;
  entityId: string;
}

/**
 * Resolves the parent through its own visibility rule. A caller who may not see the
 * parent gets NOT_FOUND from the parent's own service, so an attachment endpoint can
 * never become a side door around object-level authorization (`07` §1).
 */
async function resolveParentForRead(
  entityType: string,
  entityId: string,
  actor: Principal,
): Promise<ParentContext> {
  switch (entityType) {
    case AUDIT_ENTITY.REQUEST: {
      const request = await assertRequestVisible(entityId, actor);
      return { organizationId: request.organizationId, entityType: 'ServiceRequest', entityId };
    }
    case AUDIT_ENTITY.INCIDENT: {
      const incident = await assertIncidentVisible(entityId, actor);
      return { organizationId: incident.organizationId, entityType: 'Incident', entityId };
    }
    case AUDIT_ENTITY.ARTICLE: {
      const article = await assertArticleVisible(entityId, actor);
      return { organizationId: article.organizationId, entityType: 'Article', entityId };
    }
    default:
      throw new NotFoundError('Attachments are not supported on this record type.');
  }
}

/**
 * Write-side rule: seeing a record does not by itself make you its author. A requester
 * may attach evidence to their own request; an agent may attach to work they can update;
 * an article takes an authoring grant (`27`).
 */
async function resolveParentForWrite(
  entityType: string,
  entityId: string,
  actor: Principal,
): Promise<ParentContext> {
  const parent = await resolveParentForRead(entityType, entityId, actor);

  if (entityType === AUDIT_ENTITY.REQUEST) {
    const request = await assertRequestVisible(entityId, actor);
    const mayUpdate =
      hasPermission(actor, 'request:update.any') ||
      (hasPermission(actor, 'request:update.assigned') && request.assigneeId === actor.userId);
    if (!mayUpdate && request.requesterId !== actor.userId) {
      throw new ForbiddenError('You cannot attach files to this request.');
    }
    return parent;
  }

  if (entityType === AUDIT_ENTITY.INCIDENT) {
    const incident = await assertIncidentVisible(entityId, actor);
    if (!hasPermission(actor, 'incident:update.any') && incident.reporterId !== actor.userId) {
      throw new ForbiddenError('You cannot attach files to this incident.');
    }
    return parent;
  }

  if (!hasPermission(actor, 'kb:article:author') && !hasPermission(actor, 'kb:article:publish')) {
    throw new ForbiddenError('You cannot attach files to an article.');
  }
  return parent;
}

// ---------------------------------------------------------------------------
// Upload (docs/19 §7.2)
// ---------------------------------------------------------------------------

export interface UploadInput {
  entityType: string;
  entityId: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export async function uploadAttachment(
  input: UploadInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<AttachmentView> {
  // 4 — authorization before any work: may this caller attach to THIS parent?
  const parent = await resolveParentForWrite(input.entityType, input.entityId, actor);

  // 1 — size, before anything reads or stores the body.
  if (input.data.length === 0) {
    throw new ValidationError([{ field: 'file', message: 'The file is empty.' }]);
  }
  if (input.data.length > config.FILE_MAX_BYTES) {
    throw new AppError({
      code: 'PAYLOAD_TOO_LARGE',
      message: `Attachment exceeds ${config.FILE_MAX_BYTES} bytes.`,
    });
  }

  // 2/3 — sniff and allow-list. The stored type is the sniffed one, never the claim.
  const scan = scanUpload(input.data, input.contentType);
  const filename = sanitizeFilename(input.filename);
  const storage = fileStorage();

  // 6 — persist metadata. A rejected payload is recorded on the record and audited, so
  // it is evidence rather than a silent drop; the row can never be served because
  // status gates every read path.
  const row = await runInTransaction(async (tx) => {
    const used = await countAttachmentsForParent(
      {
        organizationId: parent.organizationId,
        entityType: parent.entityType,
        entityId: parent.entityId,
      },
      tx,
    );
    if (used >= config.FILE_MAX_PER_RECORD) {
      throw new AppError({
        code: 'CONFLICT',
        message: `A record may hold at most ${config.FILE_MAX_PER_RECORD} attachments.`,
      });
    }

    const created = await createAttachment(
      {
        organizationId: parent.organizationId,
        entityType: parent.entityType,
        entityId: parent.entityId,
        uploaderId: actor.userId,
        filename,
        // 5 — server-generated key; the client filename never reaches storage.
        storageKey: newStorageKey(parent.organizationId),
        contentType: scan.ok ? canonicalContentType(scan.contentType) : input.contentType,
        sizeBytes: input.data.length,
        status: scan.ok ? 'PENDING' : 'QUARANTINED',
      },
      tx,
    );

    await writeAudit(
      {
        organizationId: parent.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: scan.ok ? AUDIT_ACTION.ATTACHMENT_UPLOAD : AUDIT_ACTION.ATTACHMENT_QUARANTINED,
        entityType: AUDIT_ENTITY.ATTACHMENT,
        entityId: created.id,
        after: {
          parentType: parent.entityType,
          parentId: parent.entityId,
          filename: created.filename,
          sizeBytes: created.sizeBytes,
          contentType: created.contentType,
          ...(scan.ok ? {} : { reason: scan.reason }),
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return created;
  });

  if (!scan.ok) {
    throw new ValidationError([
      { field: 'file', message: `The file was rejected: ${scan.reason}`, code: 'FILE_REJECTED' },
    ]);
  }

  // 8 — store the bytes outside the transaction (docs/33 §11). A failure here leaves the
  // row PENDING: metadata exists, and no response can serve it.
  try {
    await storage.put(row.storageKey, input.data, row.contentType);
  } catch (error) {
    await setAttachmentStatus(row.id, 'QUARANTINED').catch(() => undefined);
    throw new AppError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The file could not be stored. Try again shortly.',
      cause: error,
    });
  }

  // 9 — promote to AVAILABLE: scanned, stored, now retrievable.
  const available = await setAttachmentStatus(row.id, 'AVAILABLE');
  const withUploader = await findAttachmentById(available.id);
  return toView(withUploader as AttachmentWithUploader);
}

// ---------------------------------------------------------------------------
// Read paths (docs/19 §7.3)
// ---------------------------------------------------------------------------

/** A parent's available attachments. PENDING and QUARANTINED rows are never listed. */
export async function listAttachments(
  entityType: string,
  entityId: string,
  actor: Principal,
): Promise<AttachmentView[]> {
  const parent = await resolveParentForRead(entityType, entityId, actor);
  const rows = await listAttachmentsForParent({
    organizationId: parent.organizationId,
    entityType: parent.entityType,
    entityId: parent.entityId,
  });
  return rows.map(toView);
}

/**
 * Authorises one download. Called on every fetch — the parent's visibility is re-checked
 * here rather than assumed from upload time, so a caller who lost access to the record
 * loses access to its files (`19` §7.3).
 */
export async function openAttachment(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<DownloadTarget> {
  const row = await findAttachmentById(id);
  // Unknown, invisible, or not yet clear of the scan step: indistinguishable outcomes,
  // because a distinct "quarantined" answer would confirm the file's existence.
  if (!row || row.status !== 'AVAILABLE') {
    throw new NotFoundError('Attachment not found.');
  }

  const parent = await resolveParentForRead(row.entityType, row.entityId, actor);
  if (parent.organizationId !== row.organizationId) {
    throw new NotFoundError('Attachment not found.');
  }

  // Authorised — record the disclosure before handing over the bytes (§7.3).
  await recordDownload(row, actor, meta);

  const storage = fileStorage();
  if (storage.driver === 's3') {
    const url = await storage.signedDownloadUrl(row.storageKey);
    if (url) return { kind: 'redirect', url };
  }

  const stream = await storage.open(row.storageKey);
  if (!stream) {
    throw new NotFoundError('Attachment not found.');
  }

  const filename = sanitizeFilename(row.filename);
  const inline = row.contentType.startsWith('image/');
  return {
    kind: 'stream',
    stream,
    // Non-images never render in a tab: restrictive type plus `attachment` disposition,
    // so a stored document cannot execute in the application's context (§7.3).
    contentType: inline ? row.contentType : 'application/octet-stream',
    filename,
    disposition: contentDisposition(filename, inline),
  };
}

async function recordDownload(row: Attachment, actor: Principal, meta: RequestMeta): Promise<void> {
  await writeAudit({
    organizationId: row.organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.ATTACHMENT_DOWNLOAD,
    entityType: AUDIT_ENTITY.ATTACHMENT,
    entityId: row.id,
    after: { parentType: row.entityType, parentId: row.entityId, filename: row.filename },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp ?? null,
    userAgent: meta.userAgent ?? null,
  });
}
