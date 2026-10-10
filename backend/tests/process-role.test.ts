import { describe, expect, it } from 'vitest';
import { schema } from '../src/config/env';
import { runsSchedulers, servesHttp } from '../src/config';

/**
 * Process tiers — unit tests (`docs/03` §3/§6, `docs/34` §4).
 *
 * The rule "the worker does not serve HTTP and the API does not own the schedulers" is a
 * **predicate over a role**, not a property of whichever entrypoint happens to read it, so it
 * is testable without starting a process. Getting this wrong in production is expensive in a
 * specific way: N API instances each scheduling duplicates every sweep, and the Redis lock
 * hides it until the lock has a bad day (`docs/03` J5).
 */

const baseEnv = {
  DATABASE_URL: 'postgresql://servicehub:servicehub@localhost:5432/servicehub?schema=public',
  CORS_ORIGIN: 'http://localhost:5173',
  AUTH_SECRET: 'test-only-secret-value-at-least-32-characters',
  NODE_ENV: 'test' as const,
};

function roleFor(value?: string): string {
  const parsed = schema.safeParse({ ...baseEnv, ...(value ? { PROCESS_ROLE: value } : {}) });
  if (!parsed.success) {
    throw new Error(`unexpected validation failure: ${parsed.error.message}`);
  }
  return parsed.data.PROCESS_ROLE;
}

describe('process role', () => {
  it('defaults to a single process running both tiers, for a developer box', () => {
    expect(roleFor()).toBe('all');
  });

  it('splits HTTP and schedulers between the api and worker roles', () => {
    // The split is exclusive: a role that serves HTTP must not schedule, and vice versa.
    expect(servesHttp('api')).toBe(true);
    expect(runsSchedulers('api')).toBe(false);

    expect(servesHttp('worker')).toBe(false);
    expect(runsSchedulers('worker')).toBe(true);

    expect(servesHttp('all')).toBe(true);
    expect(runsSchedulers('all')).toBe(true);
  });

  it('refuses an unknown role rather than guessing a tier', () => {
    const parsed = schema.safeParse({ ...baseEnv, PROCESS_ROLE: 'scheduler' });
    expect(parsed.success).toBe(false);
  });
});
