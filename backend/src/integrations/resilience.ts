import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Reliability patterns for every outbound integration call (`docs/32` §8).
 *
 * The document names five patterns; a timeout and bounded retry already live beside the
 * adapters, and the dead letter lives in each worker. This module supplies the two that
 * were missing, and it supplies them in one place because they are properties of the
 * **call**, not of any one vendor:
 *
 *   - **Circuit breaker** — a remote that is down should be *not called*, not called and
 *     waited on. After `failureThreshold` consecutive failures the breaker opens and every
 *     attempt fails fast for `openMs`; then one probe is allowed, and the breaker closes
 *     only after `halfOpenSuccesses` probes succeed. The point is to stop paying a timeout
 *     per attempt while the far side is broken, and to stop a queue of doomed calls from
 *     exhausting this process's capacity.
 *   - **Bulkhead** — one integration's failure must not exhaust the capacity of another.
 *     Every integration has its own bounded concurrency and its own bounded wait queue, so
 *     a slow subscriber cannot consume the slots of, say, the email provider.
 *
 * Both are **per-named-integration**, because that is the isolation boundary: `email` and
 * `webhook:<subscriptionId>` do not share a breaker or a bulkhead.
 *
 * Nothing here throws. A rejection is a domain-level outcome — the same kind of value the
 * adapters already return — because a thrown exception out of an external call is how an
 * integration failure reaches the request path (`docs/32` §1).
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. */
  failureThreshold?: number;
  /** How long the breaker stays open before a probe is allowed. */
  openMs?: number;
  /** Consecutive successful probes required to close a half-open breaker. */
  halfOpenSuccesses?: number;
}

interface ResolvedBreakerOptions extends Required<CircuitBreakerOptions> {
  now: () => number;
}

/**
 * A closed→open→half-open→closed state machine.
 *
 * It is deliberately small and synchronous: it holds counters and a timestamp, nothing
 * else. Anything cleverer (sliding windows, success-rate thresholds) buys precision this
 * failure mode does not need and makes the state harder to reason about during an incident.
 */
export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private readonly options: ResolvedBreakerOptions;

  constructor(name: string, options: CircuitBreakerOptions = {}, now: () => number = Date.now) {
    this.name = name;
    this.options = {
      failureThreshold: options.failureThreshold ?? config.INTEGRATION_BREAKER_FAILURE_THRESHOLD,
      openMs: options.openMs ?? config.INTEGRATION_BREAKER_OPEN_MS,
      halfOpenSuccesses:
        options.halfOpenSuccesses ?? config.INTEGRATION_BREAKER_HALF_OPEN_SUCCESSES,
      now,
    };
  }

  /** Current state, accounting for the open→half-open transition that time performs. */
  get current(): CircuitState {
    if (this.state === 'open' && this.options.now() - this.openedAt >= this.options.openMs) {
      // The cooldown has elapsed: allow a single probe without mutating the stored state, so
      // a probe that never arrives leaves the breaker open rather than silently closed.
      return 'half-open';
    }
    return this.state;
  }

  /**
   * Whether a call may proceed. A half-open breaker admits one probe at a time; concurrent
   * callers are rejected so the remote is not hit by a thundering herd the moment it
   * recovers.
   */
  tryAcquire(): { allowed: true } | { allowed: false; reason: string } {
    const state = this.current;
    if (state === 'open') {
      return { allowed: false, reason: `The ${this.name} integration is temporarily unavailable.` };
    }
    if (state === 'half-open') {
      if (this.state === 'open') {
        // First caller after the cooldown performs the transition to half-open.
        this.transition('half-open');
      } else {
        return {
          allowed: false,
          reason: `The ${this.name} integration is recovering; try again shortly.`,
        };
      }
    }
    return { allowed: true };
  }

  recordSuccess(): void {
    if (this.state !== 'half-open') {
      this.failures = 0;
      return;
    }
    this.successes += 1;
    if (this.successes >= this.options.halfOpenSuccesses) {
      this.transition('closed');
    }
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      // A failed probe means the remote is still unhealthy: open again for a full cooldown.
      this.transition('open');
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.transition('open');
    }
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.failures = 0;
    this.successes = 0;
    if (next === 'open') {
      this.openedAt = this.options.now();
      // One line per transition, not per rejected call: an open breaker is a single
      // operational fact, and logging each fast-fail would be the log flood L5 forbids.
      logger.warn({ integration: this.name, from: previous }, 'Integration circuit opened');
    } else if (next === 'closed') {
      logger.info({ integration: this.name, from: previous }, 'Integration circuit closed');
    }
  }

  /** Snapshot for metrics/logging; never includes anything call-specific. */
  snapshot(): { name: string; state: CircuitState; failures: number } {
    return { name: this.name, state: this.current, failures: this.failures };
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
  }
}

export interface BulkheadOptions {
  /** In-flight calls permitted at once. */
  maxConcurrent?: number;
  /** Waiters permitted behind the in-flight calls before rejections begin. */
  maxQueue?: number;
  /** How long a queued call waits for a slot before it is rejected. */
  queueTimeoutMs?: number;
}

interface Waiter {
  /** `true` when the slot was handed over; `false` when the wait timed out. */
  resolve: (acquired: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * A bounded semaphore in front of an integration.
 *
 * `maxConcurrent` bounds load on the remote; `maxQueue` plus `queueTimeoutMs` bound *this
 * process's* memory and latency — a caller that cannot get a slot within the wait window is
 * rejected rather than parked indefinitely (`docs/33` §6 backpressure).
 */
export class Bulkhead {
  readonly name: string;
  private inFlight = 0;
  private readonly queue: Waiter[] = [];
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs: number;

  constructor(name: string, options: BulkheadOptions = {}) {
    this.name = name;
    this.maxConcurrent = options.maxConcurrent ?? config.INTEGRATION_BULKHEAD_MAX_CONCURRENT;
    this.maxQueue = options.maxQueue ?? config.INTEGRATION_BULKHEAD_MAX_QUEUE;
    this.queueTimeoutMs = options.queueTimeoutMs ?? config.INTEGRATION_BULKHEAD_QUEUE_TIMEOUT_MS;
  }

  get depth(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.queue.length };
  }

  private async acquire(): Promise<boolean> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return true;
    }
    if (this.queue.length >= this.maxQueue) {
      return false;
    }

    // Waiting for a slot. A `true` here means the slot was **transferred** by `release` — not
    // released and re-acquired — so no counter is incremented on this path. That is what
    // prevents the window in which a new caller could take a slot already promised to a
    // waiter.
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.queue.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.queue.splice(index, 1);
        resolve(false);
      }, this.queueTimeoutMs);
      this.queue.push({ resolve, timer });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      // Direct hand-off: `inFlight` is unchanged because the running call's slot becomes the
      // waiter's.
      next.resolve(true);
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /**
   * Runs `fn` under this bulkhead. Returns a rejection reason instead of throwing when no
   * slot is available, so the caller maps it to its own failure outcome like any other.
   */
  async run<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    const acquired = await this.acquire();
    if (!acquired) {
      return {
        ok: false,
        reason: `The ${this.name} integration is at capacity; the call was not attempted.`,
      };
    }
    try {
      return { ok: true, value: await fn() };
    } finally {
      this.release();
    }
  }

  /** Test-only: drain queue state so a suite starts from a clean bulkhead. */
  reset(): void {
    for (const waiter of this.queue) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.queue.length = 0;
    this.inFlight = 0;
  }
}

// ── Registry ────────────────────────────────────────────────────────────────
//
// Breakers and bulkheads are per named integration and live for the process's lifetime:
// the state *is* the memory of recent failures, so rebuilding one per call would defeat
// the pattern entirely.

const breakers = new Map<string, CircuitBreaker>();
const bulkheads = new Map<string, Bulkhead>();

export function getCircuitBreaker(
  name: string,
  options: CircuitBreakerOptions = {},
): CircuitBreaker {
  const existing = breakers.get(name);
  if (existing) return existing;
  const breaker = new CircuitBreaker(name, options);
  breakers.set(name, breaker);
  return breaker;
}

export function getBulkhead(name: string, options: BulkheadOptions = {}): Bulkhead {
  const existing = bulkheads.get(name);
  if (existing) return existing;
  const bulkhead = new Bulkhead(name, options);
  bulkheads.set(name, bulkhead);
  return bulkhead;
}

/** A successful call carries its value; a rejection carries a domain-level reason. */
export type ResilienceResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ResilientCallOptions<T> extends CircuitBreakerOptions, BulkheadOptions {
  /**
   * Decides whether a returned value counts as a failure for the breaker. An adapter maps a
   * vendor error to a value rather than throwing, so "did this succeed?" is the adapter's
   * question, not this module's.
   */
  isFailure?: (value: T) => boolean;
}

/**
 * Runs an external call behind its breaker and bulkhead.
 *
 * Order matters: the breaker is checked first, so an open circuit costs nothing, and the
 * bulkhead is entered only for calls that will actually be attempted.
 */
export async function runResilient<T>(
  name: string,
  fn: () => Promise<T>,
  options: ResilientCallOptions<T> = {},
): Promise<ResilienceResult<T>> {
  const breaker = getCircuitBreaker(name, options);
  const gate = breaker.tryAcquire();
  if (!gate.allowed) {
    return { ok: false, reason: gate.reason };
  }

  const bulkhead = getBulkhead(name, options);
  let outcome: { ok: true; value: T } | { ok: false; reason: string };
  try {
    outcome = await bulkhead.run(fn);
  } catch (error) {
    // An adapter is not supposed to throw, but a future one might. Count it as a failure so
    // the breaker cannot be left half-open forever by a probe that never reported, then let
    // the caller decide — swallowing it here would hide a real defect.
    breaker.recordFailure();
    throw error;
  }
  if (!outcome.ok) {
    // A capacity rejection is not the remote's failure, so it must not trip the breaker.
    return { ok: false, reason: outcome.reason };
  }

  const failed = options.isFailure?.(outcome.value) ?? false;
  if (failed) {
    breaker.recordFailure();
  } else {
    breaker.recordSuccess();
  }
  return { ok: true, value: outcome.value };
}

/** Per-integration breaker/bulkhead state for metrics (`docs/34` §4 metrics categories). */
export function resilienceSnapshot(): {
  name: string;
  state: CircuitState;
  failures: number;
  inFlight: number;
  queued: number;
}[] {
  const names = new Set([...breakers.keys(), ...bulkheads.keys()]);
  return [...names].sort().map((name) => {
    const breaker = breakers.get(name);
    const bulkhead = bulkheads.get(name);
    return {
      name,
      state: breaker?.current ?? 'closed',
      failures: breaker?.snapshot().failures ?? 0,
      inFlight: bulkhead?.depth.inFlight ?? 0,
      queued: bulkhead?.depth.queued ?? 0,
    };
  });
}

/** Test-only: the registry is process-global, so a suite must be able to clear it. */
export function resetResilience(): void {
  for (const bulkhead of bulkheads.values()) bulkhead.reset();
  for (const breaker of breakers.values()) breaker.reset();
  breakers.clear();
  bulkheads.clear();
}
