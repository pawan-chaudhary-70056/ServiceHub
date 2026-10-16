# Observability assets (docs/34)

Deployment-side configuration for the signals the application already emits. The application
owns the **signals** (`docs/34` §4); this directory owns how they are **collected**, **alerted
on** and **displayed**.

| Path | Purpose |
|---|---|
| `prometheus/prometheus.yml` | Scrape configuration for the local stack and the deployed topology |
| `prometheus/alerts.yml` | The alert rules, mapped one-to-one to `docs/34` §7.2 |
| `grafana/dashboards/servicehub-overview.json` | The "Service overview" dashboard (`docs/34` §8) |

## Alert rules are a contract, not configuration

Every rule in `alerts.yml` names:

- an **owner** and a **severity** (`page` or `warn`), so it routes to someone who can act;
- a **`runbook_url`** into `docs/36`, because `docs/34` §7.1 says an alert without a runbook is
  noise;
- a threshold in the annotation text, so a reviewer can see where the number came from or
  change it in one place.

A rule that fires without a useful action is deleted or fixed (`docs/34` §7.3). That is why
there are so few: `docs/34` §7.1 alerts on symptoms that affect users, not on every internal
blip, and a dashboard can show a hundred metrics while only a handful deserve a page.

## Why these signals exist

The application exposes two families the rules depend on:

- **RED** — `servicehub_http_requests_total` and
  `servicehub_http_request_duration_seconds` (histogram, so the tail is available).
- **Worker liveness** — `servicehub_job_last_success_timestamp_seconds` per job, which is what
  turns "the queue is not moving" into an alert. Every scheduled worker records a run:
  `sla_sweep`, `notification_drain`, `report_export`, `webhook_delivery`, `inbound_webhook`,
  `roster_sync`, `attachment_scan`.

  The `ServiceHubWorkerStalled` rule watches four of the seven on purpose: `roster_sync` and
  `attachment_scan` are no-ops when their integration is unconfigured, so a stall alert for
  them would fire permanently in a perfectly valid stack — `ServiceHubSlaSweepStalled` covers
  `sla_sweep`, whose silent failure is the one that needs paging. **If you run an antivirus
  scanner (`ANTIVIRUS_URL`), add `attachment_scan` to that rule's `job=~` matcher**, because a
  scan worker that stops promoting files is otherwise invisible: uploads simply never become
  retrievable. Failures from every job are covered either way by `ServiceHubJobFailing`.
- **Integration reliability** — `servicehub_integration_circuit_state` (0 closed, 1 half-open,
  2 open) and the `…_bulkhead_in_flight` / `…_bulkhead_queued` gauges (`docs/32` §8).

## Running it locally

```bash
docker compose up -d postgres redis prometheus
# Prometheus UI:  http://localhost:9090
# Targets:        http://localhost:9090/targets
# Alerts:         http://localhost:9090/alerts
```

The compose stack scrapes `backend:4000`, so the alerts evaluate against the same metrics a
deployment would expose. A real environment points `prometheus.yml` at the service discovery
the orchestrator provides (`docs/35`).

## Limitations, stated rather than hidden

- **No Grafana container is wired into compose.** The dashboard model is committed so a
  Grafana instance can import it; standing Grafana up is a deployment decision.
- **The rules have never been evaluated against a running Prometheus in this repository.**
  `promtool check rules` is the verification, and it needs Prometheus — see the note in the
  increment entry in `docs/43`. The YAML and the JSON are syntax-validated locally.
- **No tracing exporter is wired** (`docs/34` §5, sampled traces). The correlation id already
  threads a request through logs and audit; a collector is the remaining step.
