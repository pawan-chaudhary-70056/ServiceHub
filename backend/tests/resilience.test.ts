import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Bulkhead,
  CircuitBreaker,
  getCircuitBreaker,
  resetResilience,
  resilienceSnapshot,
  runResilient,
} from '../src/integrations/resilience';

/**
 * Reliability patterns — unit tests (`docs/32` §8).
 *
 * These are pure units: the breaker is a state machine over a clock, and the bulkhead is a
 * bounded semaphore. Testing them directly is the only way to pin the transitions, because an
 * integration test can observe the *effect* of an open circuit but not the exact point at
 * which it reopened — and that transition is where the bugs live.
 */

afterEach(() => {
  resetResilience();
});

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold and resets on success', () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.current).toBe('closed');

    breaker.recordSuccess();
    breaker.recordFailure();
    // A success resets the consecutive-failure count, so two more failures are still safe.
    breaker.recordFailure();
    expect(breaker.current).toBe('closed');
  });

  it('opens at the threshold and rejects every attempt while open', () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 2 });
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.current).toBe('open');
    expect(breaker.tryAcquire()).toEqual({
      allowed: false,
      reason: 'The test integration is temporarily unavailable.',
    });
  });

  it('admits a single probe once the cooldown elapses, then closes after enough successes', () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      'test',
      { failureThreshold: 1, openMs: 1_000, halfOpenSuccesses: 2 },
      () => now,
    );
    breaker.recordFailure();
    expect(breaker.current).toBe('open');

    now = 999;
    expect(breaker.tryAcquire().allowed).toBe(false);

    now = 1_000;
    expect(breaker.current).toBe('half-open');
    // The first caller performs the transition and is admitted; a concurrent caller is not.
    expect(breaker.tryAcquire().allowed).toBe(true);
    expect(breaker.tryAcquire().allowed).toBe(false);

    breaker.recordSuccess();
    expect(breaker.current).toBe('half-open');
    breaker.recordSuccess();
    expect(breaker.current).toBe('closed');
  });

  it('reopens on a failed probe rather than letting a half-open breaker leak', () => {
    let now = 0;
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, openMs: 100 }, () => now);
    breaker.recordFailure();
    now = 100;
    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.recordFailure();
    expect(breaker.current).toBe('open');
  });
});

describe('Bulkhead', () => {
  it('rejects immediately when the queue is full', async () => {
    const bulkhead = new Bulkhead('test', {
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    });

    let releaseFirst: () => void = () => undefined;
    const first = bulkhead.run(() => new Promise<void>((resolve) => (releaseFirst = resolve)));
    const queued = bulkhead.run(async () => 'second');
    const rejected = await bulkhead.run(async () => 'third');

    expect(rejected).toEqual({
      ok: false,
      reason: 'The test integration is at capacity; the call was not attempted.',
    });

    releaseFirst();
    await first;
    expect(await queued).toEqual({ ok: true, value: 'second' });
  });

  it('rejects a queued call that waits longer than the timeout', async () => {
    const bulkhead = new Bulkhead('test', {
      maxConcurrent: 1,
      maxQueue: 1,
      queueTimeoutMs: 20,
    });

    let releaseFirst: () => void = () => undefined;
    const first = bulkhead.run(() => new Promise<void>((resolve) => (releaseFirst = resolve)));

    const queued = await bulkhead.run(async () => 'never runs');
    expect(queued.ok).toBe(false);
    expect(queued).toMatchObject({ reason: expect.stringContaining('at capacity') });

    releaseFirst();
    await first;
  });
});

describe('runResilient', () => {
  it('short-circuits an open breaker without calling the work function', async () => {
    const work = vi.fn(async () => ({ accepted: false }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runResilient('email', work, {
        failureThreshold: 2,
        isFailure: (result) => !result.accepted,
      });
    }
    const callsBefore = work.mock.calls.length;
    const outcome = await runResilient('email', work, {
      failureThreshold: 2,
      isFailure: (result) => !result.accepted,
    });

    expect(outcome.ok).toBe(false);
    // The remote was already known to be down: the work function must not have been called.
    expect(work.mock.calls.length).toBe(callsBefore);
    expect(getCircuitBreaker('email').current).toBe('open');
  });

  it('records a failure from the caller-declared predicate, not from a thrown error', async () => {
    const ok = await runResilient('directory', async () => ({ delivered: true }), {
      isFailure: (result) => !result.delivered,
    });
    expect(ok).toEqual({ ok: true, value: { delivered: true } });
    expect(resilienceSnapshot()).toEqual([
      { name: 'directory', state: 'closed', failures: 0, inFlight: 0, queued: 0 },
    ]);
  });
});
