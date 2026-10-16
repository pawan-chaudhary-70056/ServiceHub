/**
 * Test environment bootstrap.
 *
 * Loaded before any test module, so it must NOT import application config (which
 * validates the environment at import time). It only supplies safe defaults for values
 * that would otherwise be missing in a bare test run.
 *
 * Values are test-only and obviously non-production. Integration tests run against a
 * real PostgreSQL instance (docs/37 §3) — never a mocked database — because
 * constraints, transactions and locking are exactly the behaviour under test.
 */

import { afterEach } from 'vitest';

process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';

process.env.DATABASE_URL ??=
  'postgresql://servicehub:servicehub@localhost:5432/servicehub_test?schema=public';

process.env.CORS_ORIGIN ??= 'http://localhost:5173';

// Server-side sessions (`ADR-0001`) derive from this secret.
process.env.AUTH_SECRET ??= 'test-only-secret-value-at-least-32-characters';

process.env.RATE_LIMIT_WINDOW_MS ??= '60000';
process.env.RATE_LIMIT_MAX ??= '1000';

// The credential endpoints use a deliberately tight bucket in production (docs/33
// §6). A test suite drives many login attempts from one address, so the bucket is
// raised here — the limiter itself is not what these tests exercise.
process.env.AUTH_RATE_LIMIT_WINDOW_MS ??= '60000';
process.env.AUTH_RATE_LIMIT_MAX ??= '100000';

// Uploads (docs/19 §7) land in a test-local directory rather than the development
// storage root, so an integration suite cannot leave files where a developer's app
// would serve them from.
process.env.FILE_STORAGE_DIR ??= './.storage-test';

/**
 * Reset the integration resilience registry between tests.
 *
 * The breaker registry is **process-global by design** — the memory of recent failures *is*
 * the pattern, so rebuilding one per call would defeat it. That makes it shared state across a
 * test file, and a test that deliberately drives a provider to failure would otherwise leave
 * an open circuit for every test after it. Clearing between tests restores the isolation the
 * suite assumes without changing production behaviour.
 *
 * The import is dynamic on purpose: this file must not import application config before the
 * environment defaults above are set, and `resilience` reaches `config`.
 */
afterEach(async () => {
  const { resetResilience } = await import('../src/integrations/resilience');
  resetResilience();

  // The report cache is process-global by design (it is a cache), and most suites write
  // rows through Prisma directly — which bypasses the service mutations that invalidate
  // their class — so a leftover entry from an earlier test would be served to a later one.
  // Dropping the in-process store between tests restores the isolation the suite assumes.
  const { resetReportCache } = await import('../src/services/report-cache');
  resetReportCache();
});
