import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMetrics } from '../src/services/metrics.service';

/**
 * Observability asset drift guard (`docs/34` §4/§7/§8, `docs/00` §6 drift audit).
 *
 * The alert rules and the dashboard reference metric names in *text*. Nothing in TypeScript
 * checks those strings, so a rename in the registry would silently break the alerting — the
 * worst kind of failure, because it fails quietly and is discovered during an incident.
 *
 * This test is that check: every `servicehub_*` metric named in `ops/observability` must be a
 * family the application actually exposes, and every alert must carry the owner and severity
 * `docs/34` §7.1 requires.
 */

/**
 * Resolves a repository-relative path from either the package directory (the normal `npm test`
 * cwd) or the repository root, so the guard works whichever way the suite is invoked.
 */
function repoFile(relative: string): string {
  for (const base of [process.cwd(), resolve(process.cwd(), '..')]) {
    const candidate = resolve(base, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate ${relative} from ${process.cwd()}`);
}

const ALERTS = repoFile('ops/observability/prometheus/alerts.yml');
const DASHBOARD = repoFile('ops/observability/grafana/dashboards/servicehub-overview.json');

/** The metric families the registry declares, from the exposition's `# HELP` lines. */
function exposedFamilies(): Set<string> {
  const text = renderMetrics();
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^# HELP (\S+)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

function referencedMetrics(text: string): string[] {
  return [...new Set(text.match(/servicehub_[a-z0-9_]+/g) ?? [])].sort();
}

describe('observability assets', () => {
  const alerts = readFileSync(ALERTS, 'utf8');
  const dashboardRaw = readFileSync(DASHBOARD, 'utf8');

  it('references only metric families the registry exposes', () => {
    const exposed = exposedFamilies();
    expect(exposed.size).toBeGreaterThan(0);

    const referenced = [...referencedMetrics(alerts), ...referencedMetrics(dashboardRaw)].filter(
      (name) => !name.endsWith('_bucket'),
    );

    const missing = referenced.filter((name) => !exposed.has(name));
    expect(missing).toEqual([]);
  });

  it('gives every alert an owner, a severity and a runbook link', () => {
    // Split into rule blocks on the list item; each block runs to the next `- alert:`.
    const blocks = alerts.split(/\n\s*- alert: /).slice(1);
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const name = block.split('\n')[0]?.trim();
      expect(name, 'alert name').toMatch(/^[A-Za-z][A-Za-z0-9]+$/);
      expect(block, `${name} severity`).toMatch(/\n\s+severity: (page|warn)\n/);
      expect(block, `${name} owner`).toMatch(/\n\s+owner: \S+\n/);
      expect(block, `${name} runbook`).toMatch(/runbook_url: docs\/\d+/);
      expect(block, `${name} condition`).toMatch(/\n\s+expr: /);
    }
  });

  it('ships a dashboard whose panels all query a metric', () => {
    const dashboard = JSON.parse(dashboardRaw) as {
      uid: string;
      panels: Array<{ id: number; title: string; targets?: Array<{ expr?: string }> }>;
    };

    expect(dashboard.uid).toBe('servicehub-overview');
    expect(dashboard.panels.length).toBeGreaterThan(0);
    for (const panel of dashboard.panels) {
      expect(panel.title, `panel ${panel.id} title`).toBeTruthy();
      const exprs = panel.targets?.map((target) => target.expr).filter(Boolean) ?? [];
      expect(exprs.length, `panel ${panel.id} (${panel.title}) has no query`).toBeGreaterThan(0);
    }
  });
});
