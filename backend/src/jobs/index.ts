/**
 * Asynchronous tier (docs/03 §6, docs/29 §3, docs/33 §10).
 *
 * Anything slow, bursty or external is enqueued rather than awaited in a request, so
 * request latency stays independent of a provider's latency. The rules below are the
 * ones that fail in production if they are treated as optional:
 *
 *   J1  Jobs are IDEMPOTENT. Every worker may process a message more than once; effects
 *       are keyed on the idempotency key, not on "this should only run once".
 *   J2  Jobs are VERSIONED. Changing a payload shape adds a version; it never mutates a
 *       payload already in flight.
 *   J3  A job never assumes a prior job ran — it verifies state.
 *   J4  Poison messages are DEAD-LETTERED after bounded attempts, with an alert. A
 *       silently dropped message is a silent data loss.
 *   J5  Scheduled jobs run under a DISTRIBUTED LOCK. N backend instances each running
 *       the scheduler is the classic horizontal-scaling defect — the SLA breach sweep
 *       firing N times per interval (docs/25 §6).
 *
 * Reliability boundary: the job row is written to the outbox in the SAME TRANSACTION as
 * the domain mutation that caused it. That is what makes "the record changed but no one
 * was told" impossible, and what keeps a provider outage from rolling back a business
 * change (docs/29 §3).
 */

export type JobClass =
  | 'delivery' // email, SMS, webhooks — triggered by domain events
  | 'scheduling' // SLA sweep, escalation, digests — cron, single leader
  | 'compute' // report generation, bulk export, large import — user request
  | 'integration' // inbound sync, outbound reconcile — cron or event
  | 'maintenance'; // retention pruning, archival, orphan cleanup — cron

export type JobVersion = `${string}.v${number}`;

export interface JobEnvelope<TPayload = unknown> {
  /** Stable job type, e.g. `notification.deliver`. */
  type: string;
  /** Payload schema version — J2. */
  version: JobVersion;
  /** Deduplication key for at-least-once delivery — J1. */
  idempotencyKey: string;
  /** Correlation id of the request that caused this job (docs/34 §3.4). */
  correlationId: string;
  payload: TPayload;
  /** Bounded attempt count; exceeding it dead-letters the message — J4. */
  attempt: number;
}

export interface JobHandler<TPayload = unknown> {
  type: string;
  version: JobVersion;
  handle(envelope: JobEnvelope<TPayload>): Promise<void>;
}

export interface SchedulerOptions {
  /** Name of the distributed lock guarding this schedule — J5. */
  lockName: string;
  /** Interval in milliseconds. Worst-case detection delay equals this value. */
  intervalMs: number;
  run(): Promise<void>;
}

/**
 * Job registration is intentionally empty at scaffold stage.
 *
 * The first handlers, in phase-2 order (docs/40): notification delivery (`29`),
 * SLA breach/at-risk sweep (`25`), report and export generation (`30`), inbound
 * integration reconciliation (`32`), and retention/archival maintenance (`19`, `33`).
 *
 * The broker is Redis (`ADR-0003`). The worker workload now exists as its own entrypoint,
 * `src/worker.ts` (`PROCESS_ROLE=worker`), because the six schedulers must not share a process
 * with the HTTP listener (`docs/03` §3: a worker must not serve HTTP). This module remains the
 * envelope and policy description; the running schedules are each `services/*-scheduler.ts`.
 */
export const registeredHandlers: readonly JobHandler[] = [];
export const registeredSchedules: readonly SchedulerOptions[] = [];
