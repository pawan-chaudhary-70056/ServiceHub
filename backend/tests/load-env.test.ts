import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Local `.env` loader — unit tests (`docs/35` §2/§7).
 *
 * The two properties that make this safe to run in every entrypoint, and that a future edit
 * could quietly break:
 *
 *   1. **An injected environment wins.** A deployed process has real secrets in its
 *      environment and sometimes a stray file nearby; the file must never override them.
 *   2. **A missing file is normal.** Containers have no `.env` at all, so absence must be a
 *      no-op rather than a boot failure.
 *
 * The test points `ENV_FILE` at a temp file of its own, so it never reads (or depends on) the
 * developer's real `backend/.env` and never leaves values behind (`ENV_FILE` is read at call
 * time, and the module is imported dynamically *after* it is set).
 */

let tempDir: string;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'servicehub-loadenv-'));
  for (const key of ['ENV_FILE', 'FROM_FILE_ONLY', 'IN_BOTH_PLACES']) {
    savedEnv.set(key, process.env[key]);
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('loadLocalEnv', () => {
  it('fills an absent value from the file but never overrides the environment', async () => {
    const envFile = join(tempDir, '.env');
    writeFileSync(envFile, 'FROM_FILE_ONLY=from_file\nIN_BOTH_PLACES=from_file\n');
    process.env.ENV_FILE = envFile;
    process.env.IN_BOTH_PLACES = 'from_environment';

    // Importing the module performs the load, exactly as an entrypoint's first import does.
    const { loadLocalEnv } = await import('../src/config/load-env');

    expect(process.env.FROM_FILE_ONLY).toBe('from_file');
    expect(process.env.IN_BOTH_PLACES).toBe('from_environment');
    // The call is also usable directly, and reports what it did.
    expect(loadLocalEnv(envFile)).toEqual({ loaded: true, path: envFile });
  });

  it('treats a missing file as a no-op rather than a boot failure', async () => {
    process.env.ENV_FILE = join(tempDir, 'does-not-exist.env');
    const { loadLocalEnv } = await import('../src/config/load-env');

    expect(() => loadLocalEnv()).not.toThrow();
    expect(loadLocalEnv()).toEqual({ loaded: false, path: process.env.ENV_FILE });
  });
});
