import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import {
  LATENCY_BUCKETS,
  recordJobRun,
  recordRequest,
  renderMetrics,
  resetMetrics,
  routeLabel,
  statusClass,
} from '../src/services/metrics.service';

/**
 * Metrics tests (docs/34 §4, §11 acceptance criteria 6, docs/37 §5).
 *
 * The assertions are the document's own rules rather than a snapshot of the output:
 *
 *   - **no high-cardinality labels** — a record id never becomes a label, whether it came
 *     from a route pattern or from an unmatched URL a scanner walked;
 *   - **histograms, counters and gauges** are the three shapes exposed;
 *   - the scrape endpoint is internal, cheap and independent of the database.
 */

const app = createApp();
const BASE = '/api/v1';

beforeEach(() => {
  resetMetrics();
});

describe('metrics registry', () => {
  it('replaces id-like path segments so a record id can never be a label', () => {
    expect(routeLabel('/api/v1/requests/:id')).toBe('/api/v1/requests/:id');
    expect(routeLabel('/api/v1/requests/0191f2a4-8e5b-7000-8000-0123456789ab')).toBe(
      '/api/v1/requests/:id',
    );
    expect(routeLabel('/api/v1/attachments/0191f2a48e5b700080000123456789ab/content')).toBe(
      '/api/v1/attachments/:id/content',
    );
    // A query string must not become part of the label either.
    expect(routeLabel('/api/v1/search?q=payroll')).toBe('/api/v1/search');
    expect(routeLabel('')).toBe('unknown');
  });

  it('records a counter per route, method and status class', () => {
    recordRequest('GET', '/api/v1/requests/:id', 200, 0.02);
    recordRequest('GET', '/api/v1/requests/:id', 404, 0.01);
    recordRequest('POST', '/api/v1/requests', 500, 1.4);

    const text = renderMetrics();
    expect(text).toContain(
      'servicehub_http_requests_total{method="GET",route="/api/v1/requests/:id",status_class="2xx"} 1',
    );
    expect(text).toContain(
      'servicehub_http_requests_total{method="GET",route="/api/v1/requests/:id",status_class="4xx"} 1',
    );
    expect(text).toContain(
      'servicehub_http_requests_total{method="POST",route="/api/v1/requests",status_class="5xx"} 1',
    );
    expect(statusClass(204)).toBe('2xx');
  });

  it('buckets latency cumulatively with a +Inf bucket and a sum', () => {
    recordRequest('GET', '/api/v1/health/live', 200, 0.03);
    recordRequest('GET', '/api/v1/health/live', 200, 0.2);
    recordRequest('GET', '/api/v1/health/live', 200, 12);

    const text = renderMetrics();
    const labels = 'method="GET",route="/api/v1/health/live"';
    // 0.03 <= 0.05, so the first bucket counts one; cumulative means later buckets only grow.
    expect(text).toContain(
      `servicehub_http_request_duration_seconds_bucket{${labels},le="0.05"} 1`,
    );
    expect(text).toContain(
      `servicehub_http_request_duration_seconds_bucket{${labels},le="0.25"} 2`,
    );
    expect(text).toContain(`servicehub_http_request_duration_seconds_bucket{${labels},le="10"} 2`);
    expect(text).toContain(
      `servicehub_http_request_duration_seconds_bucket{${labels},le="+Inf"} 3`,
    );
    expect(text).toContain(`servicehub_http_request_duration_seconds_count{${labels}} 3`);
    expect(text).toMatch(
      new RegExp(`servicehub_http_request_duration_seconds_sum\\{${labels}\\} 12\\.23`),
    );
    expect(LATENCY_BUCKETS.length).toBeGreaterThan(0);
  });

  it('exposes job success and failure timestamps so a stalled sweep is visible', () => {
    recordJobRun('sla_sweep', true, new Date('2026-10-09T10:00:00.000Z'));
    recordJobRun('sla_sweep', false, new Date('2026-10-09T11:00:00.000Z'));

    const text = renderMetrics();
    expect(text).toContain('servicehub_job_runs_total{job="sla_sweep",result="success"} 1');
    expect(text).toContain('servicehub_job_runs_total{job="sla_sweep",result="failure"} 1');
    expect(text).toContain(
      `servicehub_job_last_success_timestamp_seconds{job="sla_sweep"} ${Date.parse('2026-10-09T10:00:00.000Z') / 1000}`,
    );
    expect(text).toContain(
      `servicehub_job_last_failure_timestamp_seconds{job="sla_sweep"} ${Date.parse('2026-10-09T11:00:00.000Z') / 1000}`,
    );
  });

  it('never emits a label containing a record id', () => {
    recordRequest('GET', '/api/v1/requests/0191f2a4-8e5b-7000-8000-0123456789ab', 200, 0.01);
    const text = renderMetrics();
    expect(text).not.toContain('0191f2a4-8e5b-7000-8000-0123456789ab');
  });

  it('exposes the integration circuit and bulkhead state (docs/32 §8, docs/34 §4)', async () => {
    // The breaker is a process-global registry; reset clears it between tests.
    const { getCircuitBreaker, resetResilience } = await import('../src/integrations/resilience');
    resetResilience();

    const breaker = getCircuitBreaker('email', { failureThreshold: 1 });
    breaker.recordFailure();

    const text = renderMetrics();
    expect(text).toContain('servicehub_integration_circuit_state{integration="email"} 2');
    expect(text).toContain('servicehub_integration_bulkhead_in_flight{integration="email"} 0');
    expect(text).toContain('servicehub_integration_bulkhead_queued{integration="email"} 0');
  });
});

describe('GET /api/v1/health/metrics', () => {
  it('serves the Prometheus text format without touching the database', async () => {
    await request(app).get(`${BASE}/health/live`).expect(200);

    const response = await request(app).get(`${BASE}/health/metrics`).expect(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-type']).toContain('version=0.0.4');
    expect(response.text).toContain(
      'servicehub_http_requests_total{method="GET",route="/api/v1/health/live",status_class="2xx"}',
    );
    expect(response.text).toContain('servicehub_process_uptime_seconds');
  });

  it('records an unmatched path as one series, not one per URL', async () => {
    await request(app).get(`${BASE}/does-not-exist/one`).expect(404);
    await request(app).get(`${BASE}/does-not-exist/two`).expect(404);

    const response = await request(app).get(`${BASE}/health/metrics`).expect(200);
    const unmatched = response.text
      .split('\n')
      .filter(
        (line) => line.startsWith('servicehub_http_requests_total') && line.includes('unmatched'),
      );
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toContain('status_class="4xx"} 2');
  });
});
