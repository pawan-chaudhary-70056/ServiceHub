import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  attachmentHref,
  listAttachments,
  uploadAttachment,
  MAX_ATTACHMENT_BYTES,
  type AttachmentEntityType,
} from '../api/attachments.api';
import { StatusBadge } from './status-badge';

/**
 * Attachments on a record (docs/19 §7, docs/22 §12, docs/16).
 *
 * The panel is deliberately thin: it lists what the server says is available and offers
 * an upload. Every interesting decision is server-side — the parent's authorization, the
 * sniff, the caps, the scan gate — because a browser check is UX and never a control
 * (docs/12 §1). The one client-side rule kept here is the size cap, so a 12 MB file
 * fails instantly with a cause and a remedy (docs/16) instead of after a round trip.
 *
 * A download is a plain same-origin link: the browser sends the session cookie and the
 * server re-authorizes the parent on every fetch, so the link never outlives the
 * caller's access to the record (docs/19 §7.3).
 */

export interface AttachmentPanelProps {
  entityType: AttachmentEntityType;
  entityId: string;
  /** Whether the caller may attempt an upload — the server still decides. */
  canUpload?: boolean;
}

export function AttachmentPanel({ entityType, entityId, canUpload = true }: AttachmentPanelProps) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const attachments = useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: ({ signal }) => listAttachments(entityType, entityId, signal),
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadAttachment(entityType, entityId, file),
    onSuccess: () => {
      setError(null);
      if (fileInput.current) fileInput.current.value = '';
      void queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const items = attachments.data?.items ?? [];

  return (
    <section aria-labelledby="attachments-heading" className="space-y-3">
      <h2 id="attachments-heading" className="text-lg font-semibold text-content">
        Attachments
      </h2>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {attachments.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading attachments…
        </p>
      )}
      {attachments.isSuccess && items.length === 0 && (
        <p className="text-sm text-content-muted">No files attached yet.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-border rounded border border-border">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-content">{item.filename}</span>
                <span className="text-xs text-content-muted">
                  {formatBytes(item.sizeBytes)} · {item.uploadedBy.displayName} ·{' '}
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge tone="neutral">
                  {item.contentType.replace(/^[^/]+\//, '').toUpperCase()}
                </StatusBadge>
                <a
                  href={attachmentHref(item.id)}
                  className="rounded border border-border px-3 py-1 text-xs text-content"
                  // The server sets `Content-Disposition`, so this is a download for
                  // documents and a rendering tab for images (docs/19 §7.3).
                  rel="noopener"
                >
                  Download
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}

      {canUpload && (
        <form
          className="flex flex-wrap items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const file = fileInput.current?.files?.[0];
            if (!file) return;
            if (file.size > MAX_ATTACHMENT_BYTES) {
              setError('Attachment exceeds 10 MB. Choose a smaller file.');
              return;
            }
            upload.mutate(file);
          }}
        >
          <input
            ref={fileInput}
            type="file"
            aria-label="Choose a file to attach"
            className="text-sm text-content-muted file:mr-3 file:rounded file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-content"
          />
          <button
            type="submit"
            disabled={upload.isPending}
            className="rounded bg-brand px-4 py-2 text-sm text-content-inverted disabled:opacity-60"
          >
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </button>
        </form>
      )}

      <p className="text-xs text-content-muted">
        Up to 10 MB per file, 20 files per record. Files are scanned before they appear and are only
        visible to people who can see this record.
      </p>
    </section>
  );
}

/** Human byte size — the API reports exact bytes; the UI reports what a person reads. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.errors.length > 0) {
      return `${error.message} (${error.errors.map((detail) => detail.message).join('; ')})`;
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
