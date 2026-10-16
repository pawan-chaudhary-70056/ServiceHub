/**
 * Metrics — docs/34 §4.
 *
 * A small, dependency-free Prometheus registry. It is deliberately narrow, because the
 * rules in `34` §4.2 are the whole design:
 *
 *   - **Labels are a fixed, low-cardinality set** — `method`, `route`, `status_class`,
 *     `job`. The route is the *pattern* (`/requests/:id`), never a concrete path: a user
 *     id or record id as a label is how a metrics backend dies (and how record ids leak
 *     into a monitoring system, which is a data-protection problem too — `19` §1).
 *   - **Histograms for latency, counters for events, gauges for state** — no averaging
 *     away the tail, because the tail is what users experience.
 *   - **Every metric here is acted on by an alert or a dashboard panel** (`34` §7/§8):
 *     RED for the service overview, the job gauges for "SLA sweep stalled" — the silent
 *     failure `25` §6 says must be impossible.
 *
 * The registry is process-local, which is exactly right for a scrape-based collector:
 * each instance exposes its own view and the monitoring system aggregates.
 */

import { resilienceSnapshot, type CircuitState } from '../integrations/resilience';

/** Fixed latency buckets in seconds (docs/34 §4.2: histograms, not averages). */
export const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** A numeric encoding of breaker state, because a Prometheus gauge cannot hold a word. */
const CIRCUIT_STATE_CODE: Record<CircuitState, number> = { closed: 0, 'half-open': 1, open: 2 };

interface DurationSeries {
  /** One count per bucket boundary, in `LATENCY_BUCKETS` order. */
  buckets: number[];
  count: number;
  sum: number;
}

const requests = new Map<string, number>();
const durations = new Map<string, DurationSeries>();
const jobRuns = new Map<string, number>();
const jobLastSuccess = new Map<string, number>();
const jobLastFailure = new Map<string, number>();
const cacheOperations = new Map<string, number>();

const PROCESS_STARTED_AT = Date.now();

/** Anything that looks like a record id is replaced before it can become a label. */
const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f-]{13,}|^[0-9a-hjkmnp-tv-z]{20,}$/i;

/**
 * Normalises a route into a label-safe pattern.
 *
 * The middleware already uses Express's route pattern; this is the safety net for the
 * endpoint that is *not* a route (an unmatched path, where Express exposes the raw URL).
 * A scanner walking `/orders/<uuid>` must not create one time series per request.
 */
export function routeLabel(path: string): string {
  if (!path) return 'unknown';
  const withoutQuery = path.split('?')[0] ?? '';
  const label = withoutQuery
    .split('/')
    .map((segment) => (ID_LIKE.test(segment) ? ':id' : segment))
    .join('/')
    .slice(0, 200);
  return label.length > 0 ? label : 'unknown';
}

/** `2xx` / `4xx` / `5xx` — the class is what an SLO alert asks about, not the code. */
export function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

function bucketKey(method: string, route: string): string {
  return `${method}|${route}`;
}

/** Records one completed HTTP request (the RED signal). */
export function recordRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number,
): void {
  const normalisedRoute = routeLabel(route);
  const counterKey = `${method}|${normalisedRoute}|${statusClass(statusCode)}`;
  requests.set(counterKey, (requests.get(counterKey) ?? 0) + 1);

  const key = bucketKey(method, normalisedRoute);
  const series = durations.get(key) ?? { buckets: LATENCY_BUCKETS.map(() => 0), count: 0, sum: 0 };
  series.count += 1;
  series.sum += durationSeconds;
  LATENCY_BUCKETS.forEach((boundary, index) => {
    if (durationSeconds <= boundary) {
      series.buckets[index] = (series.buckets[index] ?? 0) + 1;
    }
  });
  durations.set(key, series);
}

/**
 * Records a background job run (`docs/34` §7: "SLA sweep stalled — page, silent SLA
 * failure"). Success and failure timestamps are kept separately so an alert can ask
 * "has it succeeded recently?" rather than "has it run at all?".
 */
export function recordJobRun(job: string, success: boolean, at: Date = new Date()): void {
  const seconds = at.getTime() / 1000;
  const key = `${job}|${success ? 'success' : 'failure'}`;
  jobRuns.set(key, (jobRuns.get(key) ?? 0) + 1);

  if (success) {
    jobLastSuccess.set(job, seconds);
  } else {
    jobLastFailure.set(job, seconds);
  }
}

/**
 * Records one cache operation (`docs/33` C8: hit/miss is measured per region, so code
 * that looks cached but never serves a hit is visible rather than assumed). The region
 * set is fixed and low-cardinality, like every other label here.
 */
export type CacheOutcome = 'hit' | 'miss' | 'invalidation';

export function recordCacheOperation(region: string, outcome: CacheOutcome): void {
  const key = `${region}|${outcome}`;
  cacheOperations.set(key, (cacheOperations.get(key) ?? 0) + 1);
}

/** Escapes a label value per the Prometheus text format. */
function labelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function lines(
  out: string[],
  name: string,
  type: 'counter' | 'gauge' | 'histogram',
  help: string,
): void {
  out.push(`# HELP ${name} ${help}`);
  out.push(`# TYPE ${name} ${type}`);
}

/** Renders the whole registry in the Prometheus text exposition format. */
export function renderMetrics(): string {
  const out: string[] = [];

  lines(
    out,
    'servicehub_http_requests_total',
    'counter',
    'Completed HTTP requests by route, method and status class.',
  );
  for (const [key, value] of [...requests.entries()].sort()) {
    const [method, route, cls] = key.split('|') as [string, string, string];
    out.push(
      `servicehub_http_requests_total{method="${labelValue(method)}",route="${labelValue(route)}",status_class="${cls}"} ${value}`,
    );
  }

  lines(
    out,
    'servicehub_http_request_duration_seconds',
    'histogram',
    'HTTP request latency in seconds by route and method.',
  );
  for (const [key, series] of [...durations.entries()].sort()) {
    const [method, route] = key.split('|') as [string, string];
    const labels = `method="${labelValue(method)}",route="${labelValue(route)}"`;
    LATENCY_BUCKETS.forEach((boundary, index) => {
      out.push(
        `servicehub_http_request_duration_seconds_bucket{${labels},le="${boundary}"} ${series.buckets[index] ?? 0}`,
      );
    });
    out.push(
      `servicehub_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${series.count}`,
    );
    out.push(`servicehub_http_request_duration_seconds_sum{${labels}} ${series.sum}`);
    out.push(`servicehub_http_request_duration_seconds_count{${labels}} ${series.count}`);
  }

  lines(out, 'servicehub_job_runs_total', 'counter', 'Background job runs by job and result.');
  for (const [key, value] of [...jobRuns.entries()].sort()) {
    const [job, result] = key.split('|') as [string, string];
    out.push(
      `servicehub_job_runs_total{job="${labelValue(job)}",result="${labelValue(result)}"} ${value}`,
    );
  }

  lines(
    out,
    'servicehub_job_last_success_timestamp_seconds',
    'gauge',
    'Unix time of the last successful run of a background job (0 when it has never succeeded).',
  );
  for (const job of knownJobs()) {
    out.push(
      `servicehub_job_last_success_timestamp_seconds{job="${labelValue(job)}"} ${jobLastSuccess.get(job) ?? 0}`,
    );
  }

  lines(
    out,
    'servicehub_job_last_failure_timestamp_seconds',
    'gauge',
    'Unix time of the last failed run of a background job (0 when it has never failed).',
  );
  for (const job of knownJobs()) {
    out.push(
      `servicehub_job_last_failure_timestamp_seconds{job="${labelValue(job)}"} ${jobLastFailure.get(job) ?? 0}`,
    );
  }

  lines(
    out,
    'servicehub_cache_operations_total',
    'counter',
    'Cache hits, misses and invalidations by region (docs/33 C8).',
  );
  for (const [key, value] of [...cacheOperations.entries()].sort()) {
    const [region, outcome] = key.split('|') as [string, string];
    out.push(
      `servicehub_cache_operations_total{region="${labelValue(region)}",outcome="${outcome}"} ${value}`,
    );
  }

  const now = Date.now();
  lines(out, 'servicehub_process_start_time_seconds', 'gauge', 'Unix time the process started.');
  out.push(`servicehub_process_start_time_seconds ${PROCESS_STARTED_AT / 1000}`);

  lines(out, 'servicehub_process_uptime_seconds', 'gauge', 'Seconds since the process started.');
  out.push(`servicehub_process_uptime_seconds ${(now - PROCESS_STARTED_AT) / 1000}`);

  lines(out, 'servicehub_process_resident_memory_bytes', 'gauge', 'Resident set size in bytes.');
  out.push(`servicehub_process_resident_memory_bytes ${process.memoryUsage().rss}`);

  // Integration reliability (`docs/32` §8). A breaker that is open is the fastest way to
  // see "the remote is down", and the bulkhead gauges show whether a slow integration is
  // starting to back up — the two signals an operator needs before the queue dead-letters.
  const resilience = resilienceSnapshot();
  lines(
    out,
    'servicehub_integration_circuit_state',
    'gauge',
    'Circuit breaker state per integration (0 closed, 1 half-open, 2 open).',
  );
  for (const row of resilience) {
    out.push(
      `servicehub_integration_circuit_state{integration="${labelValue(row.name)}"} ${CIRCUIT_STATE_CODE[row.state]}`,
    );
  }

  lines(
    out,
    'servicehub_integration_bulkhead_in_flight',
    'gauge',
    'External calls in flight per integration (docs/32 §8 bulkhead).',
  );
  for (const row of resilience) {
    out.push(
      `servicehub_integration_bulkhead_in_flight{integration="${labelValue(row.name)}"} ${row.inFlight}`,
    );
  }

  lines(
    out,
    'servicehub_integration_bulkhead_queued',
    'gauge',
    'External calls waiting for a bulkhead slot per integration.',
  );
  for (const row of resilience) {
    out.push(
      `servicehub_integration_bulkhead_queued{integration="${labelValue(row.name)}"} ${row.queued}`,
    );
  }

  return `${out.join('\n')}\n`;
}

/** Jobs whose gauges are always exposed, so an alert can see "never ran" as 0. */
function knownJobs(): string[] {
  const names = new Set<string>();
  for (const key of [...jobRuns.keys(), ...jobLastSuccess.keys(), ...jobLastFailure.keys()]) {
    names.add(key.split('|')[0] ?? 'unknown');
  }
  return [...names].sort();
}

/** Test-only: the registry is process-global, so a suite must be able to clear it. */
export function resetMetrics(): void {
  requests.clear();
  durations.clear();
  jobRuns.clear();
  jobLastSuccess.clear();
  jobLastFailure.clear();
  cacheOperations.clear();
}
