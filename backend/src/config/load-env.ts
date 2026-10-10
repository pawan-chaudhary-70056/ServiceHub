import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Best-effort local `.env` loading, for the process entrypoints and the operational CLIs
 * (`docs/35` §2/§7).
 *
 * Why this exists: configuration is validated at import time and **only** reads
 * `process.env` (`env.ts`: "it never reads a committed file, so secrets can be injected at
 * runtime"). Prisma CLI commands load `.env` themselves, so `prisma migrate` worked while
 * `npm run dev`, `npm start` and the worker commands did not — they failed at boot with
 * `DATABASE_URL: Required`, which reads as a broken application rather than a missing file.
 * This closes that inconsistency for every process this package is asked to start.
 *
 * Two rules keep it safe:
 *
 *   1. **A real environment wins.** `process.loadEnvFile` (verified: it does not overwrite a
 *      variable that is already set) means a deployed process with injected secrets — or a
 *      developer with a shell export — is never overridden by a stray file. The file is a
 *      fallback for a local developer, never an authority over the environment.
 *   2. **A missing file is normal, not an error.** Deployed containers have no `.env`, so
 *      `ENOENT` is a no-op. Any *other* failure (a malformed file) is left to surface: a
 *      broken `.env` should be reported, not silently ignored and then guessed at from a
 *      confusing validation error later.
 *
 * This module deliberately imports **nothing** from the application. It must be evaluable
 * before configuration exists, which is why it is a side-effect import placed first in each
 * entrypoint, and why it cannot log (the logger itself needs configuration).
 */

/** The file read when `ENV_FILE` does not name one. Resolved against the package root (cwd). */
const DEFAULT_ENV_FILE = '.env';

export interface LoadEnvResult {
  loaded: boolean;
  path: string;
}

/**
 * Loads the local env file if one exists. Returns what happened so a caller can report it;
 * never throws for a missing file.
 */
export function loadLocalEnv(file: string | undefined = process.env.ENV_FILE): LoadEnvResult {
  const path = resolve(file && file.length > 0 ? file : DEFAULT_ENV_FILE);

  if (!existsSync(path)) {
    return { loaded: false, path };
  }

  // `loadEnvFile` throws for a missing file and for a malformed one; only the first is
  // expected here. Letting the second propagate is the point — a corrupt `.env` is a real
  // misconfiguration and must not be swallowed into a vague later failure.
  process.loadEnvFile(path);
  return { loaded: true, path };
}

// The side effect this module exists for. Importing it anywhere is enough; an entrypoint
// needs no statement of its own, which also means the ordering cannot be got wrong by a
// later edit that reorders a function call below the imports.
loadLocalEnv();
