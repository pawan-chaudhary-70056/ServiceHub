import { z } from 'zod';
import { idParam } from './index';

/**
 * Attachment request schemas (docs/19 §7, docs/12).
 *
 * The parent vocabulary is a **closed set** — `FR-FILE-001` scopes attachments to
 * requests, incidents and KB articles, and an unknown type must fail validation rather
 * than fall through to a default. The upload body is multipart, so its fields are
 * validated after parsing (in the controller) instead of by the `validate` middleware,
 * which only reads JSON bodies.
 */

export const attachmentParentTypeSchema = z.enum(['ServiceRequest', 'Incident', 'Article']);

export type AttachmentParentTypeInput = z.infer<typeof attachmentParentTypeSchema>;

export const attachmentListQuerySchema = z
  .object({
    entityType: attachmentParentTypeSchema,
    entityId: idParam,
  })
  .strict();

export type AttachmentListQuery = z.infer<typeof attachmentListQuerySchema>;

/** Multipart form fields of `POST /attachments`. */
export const attachmentUploadFieldsSchema = z
  .object({
    entityType: attachmentParentTypeSchema,
    entityId: idParam,
  })
  .strict();

export type AttachmentUploadFields = z.infer<typeof attachmentUploadFieldsSchema>;

export const attachmentContentParamsSchema = z.object({ id: idParam });
