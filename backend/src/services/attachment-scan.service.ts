import { config } from '../config';
import { antivirusAdapter, type AntivirusAdapter } from '../integrations/antivirus';
import { fileStorage, type FileStorage } from '../integrations/storage';
import { listPendingAttachments, setAttachmentStatus } from '../models';
import { logger } from '../utils/logger';

/**
 * The asynchronous antivirus scan step (`docs/19` §7.2 step 7).
 *
 * The upload path persists metadata and returns `201` with `PENDING`; **this** is what makes
 * a file retrievable. It is deliberately a worker and not part of the request: a scanner is a
 * network hop with a variable latency, and `docs/32` §1 forbids an external call inside a
 * request transaction.
 *
 * The three outcomes map onto the pipeline exactly, and none of them is allowed to be
 * optimistic:
 *
 *   - `CLEAN` → `AVAILABLE`. Retrievable from this point (`§7.2` rule 1).
 *   - `INFECTED` → `QUARANTINED`, which is terminal for serving: `getAttachmentContent` and
 *     `listAttachmentsForParent` both exclude anything that is not `AVAILABLE`, so the bytes
 *     remain stored for an auditor and reachable by no one else.
 *   - `UNAVAILABLE` → **left `PENDING`**. This is the decision that matters: a scanner that
 *     times out has not cleared the file, so the file must stay unservable and be retried on
 *     the next tick. Promoting on an unknown verdict would turn a scanner outage into a
 *     silent bypass of the only malware control in the pipeline.
 *
 * When no scanner is configured the step is a no-op, because the upload path never leaves a
 * row `PENDING` in that configuration — it promotes on the request path, which is the honest
 * behaviour for a stack with no scanner to call. The worker therefore returns
 * `configured: false` rather than doing nothing silently.
 */

export interface AttachmentScanResult {
  configured: boolean;
  scanned: number;
  available: number;
  quarantined: number;
  /** Left `PENDING` because the scanner could not answer. Retried next tick. */
  deferred: number;
  /** Could not even be read back from storage; left `PENDING` and logged. */
  unreadable: number;
}

/**
 * Runs one scan pass. The adapter and storage are injectable so the pass can be driven
 * deterministically in a test, the same seam `createRateLimiter({ store })` and
 * `processInboundWebhookEvents({ jitter })` use.
 */
export async function scanPendingAttachments(
  options: { limit?: number; storage?: FileStorage; adapter?: AntivirusAdapter } = {},
): Promise<AttachmentScanResult> {
  const adapter = options.adapter ?? antivirusAdapter();
  const result: AttachmentScanResult = {
    configured: adapter.configured,
    scanned: 0,
    available: 0,
    quarantined: 0,
    deferred: 0,
    unreadable: 0,
  };

  // Unconfigured is not "nothing to do" by accident: no row is `PENDING` in that
  // configuration, and asserting it here would only mask a misconfiguration.
  if (!adapter.configured) return result;

  const storage = options.storage ?? fileStorage();
  const limit = options.limit ?? config.ANTIVIRUS_BATCH_SIZE;
  const pending = await listPendingAttachments(limit);

  for (const attachment of pending) {
    result.scanned += 1;

    let bytes: Buffer;
    try {
      bytes = await storage.get(attachment.storageKey);
    } catch (error) {
      // The row stays PENDING, so the file is never served on a read failure — the same
      // fail-closed direction as an unavailable scanner.
      result.unreadable += 1;
      logger.error(
        { err: error, attachmentId: attachment.id },
        'Attachment scan could not read the stored object; leaving it PENDING',
      );
      continue;
    }

    const verdict = await adapter.scan({
      data: bytes,
      contentType: attachment.contentType,
    });

    if (verdict.verdict === 'CLEAN') {
      await setAttachmentStatus(attachment.id, 'AVAILABLE');
      result.available += 1;
      continue;
    }

    if (verdict.verdict === 'INFECTED') {
      await setAttachmentStatus(attachment.id, 'QUARANTINED');
      logger.warn(
        { attachmentId: attachment.id, organizationId: attachment.organizationId },
        'Attachment quarantined by the antivirus scan',
      );
      result.quarantined += 1;
      continue;
    }

    result.deferred += 1;
    logger.warn(
      { attachmentId: attachment.id, reason: verdict.reason },
      'Antivirus scan unavailable; attachment remains PENDING',
    );
  }

  return result;
}
