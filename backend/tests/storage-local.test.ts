import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Local storage driver tests (docs/19 §7.1).
 *
 * The local driver exists for single-instance development and tests, and it is the one
 * the integration suite actually exercises. Two properties matter:
 *
 *   - it keeps the same **key discipline** as the object-store driver, so a traversal key
 *     is refused before it reaches the filesystem (`§7.2` rule 3) — the guard lives in the
 *     driver, not in the caller's good behaviour;
 *   - it returns **no signed URL**, which is why the API streams the file itself here and
 *     why `env.ts` refuses this driver in production (`ADR-0004`): instance-local bytes are
 *     exactly the failure `§7.1` describes.
 */

const ROOT = path.join(os.tmpdir(), `servicehub-storage-test-${process.pid}`);
process.env.FILE_STORAGE_DRIVER = 'local';
process.env.FILE_STORAGE_DIR = ROOT;

let storage: typeof import('../src/integrations/storage');

beforeAll(async () => {
  storage = await import('../src/integrations/storage');
});

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

describe('local storage driver', () => {
  it('writes, streams back and removes an object under the key', async () => {
    const driver = storage.fileStorage();
    expect(driver.driver).toBe('local');

    const key = storage.newStorageKey('org-local');
    const bytes = Buffer.from('a small attachment');

    await driver.put(key, bytes, 'text/plain');
    const onDisk = await fs.readFile(path.join(ROOT, key));
    expect(onDisk.equals(bytes)).toBe(true);

    const stream = await driver.open(key);
    expect(stream).not.toBeNull();
    expect((await readStream(stream as NodeJS.ReadableStream)).equals(bytes)).toBe(true);

    await driver.remove(key);
    await expect(fs.access(path.join(ROOT, key))).rejects.toThrow();
  });

  it('hands back no signed URL, so the API streams and re-authorises (docs/19 §7.3)', async () => {
    await expect(storage.fileStorage().signedDownloadUrl('org-local/x')).resolves.toBeNull();
  });

  it('rejects a traversal key before touching the filesystem', async () => {
    const driver = storage.fileStorage();
    await expect(driver.put('../escaped', Buffer.from('x'), 'text/plain')).rejects.toThrowError(
      /Malformed storage key/,
    );
    await expect(driver.open('..%2Fescaped')).rejects.toThrowError(/Malformed storage key/);
    await expect(driver.remove('a/../../b')).rejects.toThrowError(/Malformed storage key/);
  });

  it('returns null for an object that is not there rather than throwing', async () => {
    await expect(storage.fileStorage().open('org-local/missing')).resolves.toBeNull();
  });
});
