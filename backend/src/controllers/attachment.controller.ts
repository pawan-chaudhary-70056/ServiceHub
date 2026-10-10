import type { Request, Response } from 'express';
import { config } from '../config';
import { parseMultipartRequest, type MultipartPayload } from '../helpers/multipart';
import { listAttachments, openAttachment, uploadAttachment } from '../services';
import { UnauthenticatedError, ValidationError, type ProblemDetail } from '../utils/errors';
import {
  attachmentUploadFieldsSchema,
  type AttachmentListQuery,
  type AttachmentUploadFields,
} from '../validators/attachment.validators';
import { validated } from '../middlewares/validate';
import { requestMeta } from './support';

/**
 * Attachment endpoints (docs/19 §7, docs/11 §9).
 *
 * Controllers translate; they do not authorize. Every call below resolves the parent
 * through the owning service's object-level rule, so this layer never has to decide who
 * may see what — it only moves bytes and metadata across the HTTP boundary. The upload
 * path parses multipart itself: `express.json()`'s 1 MB limit is for JSON, and a file
 * upload has its own cap (`docs/19` §7.4).
 */

/** Validates parsed multipart fields with the same shape the JSON path would enforce. */
function parseUploadFields(payload: MultipartPayload): AttachmentUploadFields {
  const result = attachmentUploadFieldsSchema.safeParse(payload.fields);
  if (!result.success) {
    const details: ProblemDetail[] = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    throw new ValidationError(details);
  }
  return result.data;
}

/** `GET /attachments?entityType=&entityId=` — a parent's files. */
export async function getAttachments(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<unknown, unknown, AttachmentListQuery>(res);
  const items = await listAttachments(query.entityType, query.entityId, req.actor);
  res.status(200).json({ items });
}

/** `POST /attachments` — multipart upload (docs/19 §7.2). */
export async function postAttachment(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }

  const payload = await parseMultipartRequest(req, {
    maxTotalBytes: config.FILE_MAX_TOTAL_BYTES,
    maxFiles: 1,
  });
  const fields = parseUploadFields(payload);
  const file = payload.files[0];
  if (!file) {
    throw new ValidationError([{ field: 'file', message: 'A file is required.' }]);
  }

  const attachment = await uploadAttachment(
    {
      entityType: fields.entityType,
      entityId: fields.entityId,
      filename: file.filename,
      contentType: file.contentType,
      data: file.data,
    },
    req.actor,
    requestMeta(req),
  );

  res.setHeader('Location', attachment.downloadUrl);
  res.status(201).json({ attachment });
}

/**
 * `GET /attachments/{id}/content` — authorised, audited download (docs/19 §7.3).
 *
 * The parent's visibility is re-checked inside the service on every call, and the
 * response is served with a restrictive type: non-images download as
 * `application/octet-stream` with `attachment` disposition, nothing renders as HTML,
 * and `nosniff` closes the MIME-guessing gap.
 */
export async function getAttachmentContent(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const target = await openAttachment(params.id, req.actor, requestMeta(req));

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  // Defence in depth: even an inline image response refuses scripts and framing.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

  if (target.kind === 'redirect') {
    res.redirect(302, target.url);
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', target.contentType);
  res.setHeader('Content-Disposition', target.disposition);

  await new Promise<void>((resolve, reject) => {
    target.stream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy();
        resolve();
        return;
      }
      reject(error);
    });
    target.stream.on('end', () => resolve());
    target.stream.pipe(res);
  });
}
