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
