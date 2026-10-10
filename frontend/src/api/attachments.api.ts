import { apiUpload, BASE_URL, type ProblemFieldError } from './client';
import { apiRequest } from './client';

/**
 * Attachment API (docs/19 §7, docs/11 §9).
 *
 * Access always follows the parent record — there is no attachment permission to check
 * client-side (docs/07 §4) — so the UI lists and uploads and lets the server inherit the
 * parent's rule. A refusal arrives as a normal problem response and is surfaced, never
 * swallowed (docs/16).
 */

export type AttachmentEntityType = 'ServiceRequest' | 'Incident' | 'Article';

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: 'PENDING' | 'AVAILABLE' | 'QUARANTINED';
  uploadedBy: { id: string; displayName: string };
  createdAt: string;
  /** Relative URL the browser downloads from; the server re-checks authorization. */
  downloadUrl: string;
}

/** Mirrors the server's per-file cap (docs/19 §7.4) for an immediate form-side check. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function listAttachments(
  entityType: AttachmentEntityType,
  entityId: string,
  signal?: AbortSignal,
): Promise<{ items: AttachmentView[] }> {
  const query = new URLSearchParams({ entityType, entityId });
  return apiRequest<{ items: AttachmentView[] }>(`/attachments?${query.toString()}`, { signal });
}

export function uploadAttachment(
  entityType: AttachmentEntityType,
  entityId: string,
  file: File,
): Promise<{ attachment: AttachmentView }> {
  const form = new FormData();
  form.append('entityType', entityType);
  form.append('entityId', entityId);
  // The filename travels as metadata only; the storage key is server-generated
  // (docs/19 §7.2 rule 3).
  form.append('file', file, file.name);
  return apiUpload<{ attachment: AttachmentView }>('/attachments', form);
}

/**
 * A direct link for the browser's own download handling. Same-origin, so the session
 * cookie travels; the server re-authorises the parent on every request, and a caller who
 * lost access to the record gets 404 rather than the bytes (docs/19 §7.3).
 */
export function attachmentHref(id: string): string {
  return `${BASE_URL}/attachments/${id}/content`;
}

export type { ProblemFieldError };
