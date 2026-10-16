import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClamavHttpAdapter, type AntivirusAdapter } from '../src/integrations/antivirus';
import { fileStorage, newStorageKey } from '../src/integrations/storage';
import { disconnectDatabase, prisma } from '../src/models';
import { scanPendingAttachments } from '../src/services/attachment-scan.service';

/**
 * Attachment scan worker — integration tests (`docs/19` §7.2 step 7, docs/37 §6).
 *
 * The rule under test is the pipeline's rule 1: **"files are not retrievable until scanned; a
 * quarantined file is never served"**. Read-side (`getAttachmentContent`, `listAttachments`)
 * already excludes anything that is not `AVAILABLE` — that is what the existing attachment
 * suite proves — so what matters here is the **transition out of `PENDING`** and, more
 * importantly, the transition that must *not* happen.
 *
 * The case carrying the most risk is the unavailable scanner: a scan that could not run must
 * leave the file `PENDING`, because promoting it would turn a scanner outage into a silent
 * bypass of the only malware control in the pipeline. A fake adapter is injected for each
 * case (the same seam `createRateLimiter({ store })` uses), and one case exercises the real
 * clamd adapter against a stubbed fetch to prove the wiring, not just the worker.
 */

let databaseAvailable = false;

function dbIt(name: string, fn: () => Promise<void> | void): void {
  it(name, async (ctx) => {
    if (!databaseAvailable) {
      ctx.skip();
    }
    await fn();
  });
}

const CLEAN: AntivirusAdapter = {
  configured: true,
  async scan() {
    return { verdict: 'CLEAN' };
  },
};

const INFECTED: AntivirusAdapter = {
  configured: true,
  async scan() {
    return { verdict: 'INFECTED', reason: 'The scanner identified the file as malware.' };
  },
};

const UNAVAILABLE: AntivirusAdapter = {
  configured: true,
  async scan() {
    return { verdict: 'UNAVAILABLE', reason: 'The scanner did not respond within the timeout.' };
  },
};

let organizationId: string;
let uploaderId: string;

/** A stored object with a `PENDING` metadata row, exactly as an upload leaves it. */
async function seedPendingAttachment(
  data: Buffer,
  contentType = 'application/pdf',
): Promise<string> {
  const storageKey = newStorageKey(organizationId);
  await fileStorage().put(storageKey, data, contentType);

  const row = await prisma.attachment.create({
    data: {
      organizationId,
      entityType: 'ServiceRequest',
      entityId: randomUUID(),
      uploaderId,
      filename: 'scan-fixture.pdf',
      storageKey,
      contentType,
      sizeBytes: data.byteLength,
      status: 'PENDING',
    },
  });
  return row.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await prisma.attachment.findUniqueOrThrow({ where: { id } });
  return row.status;
}

describe('attachment scan worker', () => {
  beforeAll(async () => {
    try {
      await prisma.organization.count();
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
      return;
    }

    const suffix = randomUUID().slice(0, 8);
    const organization = await prisma.organization.create({
      data: {
        name: `Scan Suite ${suffix}`,
        nameKey: `scan suite ${suffix}`,
        slug: `scan-suite-${suffix}`,
      },
    });
    organizationId = organization.id;

    const uploader = await prisma.user.create({
      data: {
        email: `scanner-${suffix}@initech.test`,
        displayName: 'Scanner Fixture',
        organizationId,
        status: 'ACTIVE',
      },
    });
    uploaderId = uploader.id;
  });

  afterAll(async () => {
    await disconnectDatabase().catch(() => undefined);
  });

  dbIt('promotes a clean file to AVAILABLE, which is what makes it retrievable', async () => {
    const id = await seedPendingAttachment(Buffer.from('%PDF-1.7 scan me'));
    expect(await statusOf(id)).toBe('PENDING');

    const result = await scanPendingAttachments({ adapter: CLEAN });

    expect(result.configured).toBe(true);
    expect(result.available).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe('AVAILABLE');
  });

  dbIt('quarantines an infected file and records when', async () => {
    const id = await seedPendingAttachment(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$'));

    const result = await scanPendingAttachments({ adapter: INFECTED });

    expect(result.quarantined).toBeGreaterThanOrEqual(1);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('QUARANTINED');
    // The timestamp is what an auditor reads; a quarantine with no time is not evidence.
    expect(row.quarantinedAt).not.toBeNull();
  });

  dbIt(
    'leaves a file PENDING when the scanner cannot answer, and scans it once it can',
    async () => {
      const id = await seedPendingAttachment(Buffer.from('%PDF-1.7 retry me'));

      const first = await scanPendingAttachments({ adapter: UNAVAILABLE });
      expect(first.deferred).toBeGreaterThanOrEqual(1);
      // The whole point: "could not scan" is not "clean".
      expect(await statusOf(id)).toBe('PENDING');

      // The next tick, with a working scanner, completes it — the row was never lost.
      await scanPendingAttachments({ adapter: CLEAN });
      expect(await statusOf(id)).toBe('AVAILABLE');
    },
  );

  dbIt('does nothing when no scanner is configured, and says so', async () => {
    const id = await seedPendingAttachment(Buffer.from('%PDF-1.7 unscanned'));

    const result = await scanPendingAttachments({
      adapter: { configured: false, scan: async () => ({ verdict: 'CLEAN' }) },
    });

    expect(result.configured).toBe(false);
    expect(result.scanned).toBe(0);
    // Without a scanner the upload path promotes on the request path, so a PENDING row in
    // this configuration is an anomaly rather than a queue — the worker must not invent a
    // promotion for it.
    expect(await statusOf(id)).toBe('PENDING');
  });

  dbIt('drives the real clamd adapter through the worker', async () => {
    const id = await seedPendingAttachment(Buffer.from('%PDF-1.7 via http'));

    const fetchMock = async (): Promise<Response> => new Response(null, { status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const result = await scanPendingAttachments({
        adapter: createClamavHttpAdapter('http://scanner.invalid/scan'),
      });
      expect(result.available).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(await statusOf(id)).toBe('AVAILABLE');
  });
});
