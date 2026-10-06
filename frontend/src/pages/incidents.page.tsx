import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createIncident,
  derivePriority,
  listIncidents,
  type IncidentImpact,
  type IncidentStatus,
  type IncidentSummary,
  type IncidentUrgency,
} from '../api/incidents.api';
import { listTeams, type TeamSummary } from '../api/teams.api';
import { StatusBadge } from '../components/status-badge';
import { incidentStatusTone, priorityTone } from '../utils/request-tones';

/**
 * Incident list and the report form (docs/23 §11).
 *
 * The list is scoped server-side to what the caller may read (own / team / any), so the
 * screen shows whatever the API returns without re-implementing scope. The report form
 * shows the **derived priority live** so the reporter understands the consequence of the
 * impact and urgency they choose (§3) — the server remains the authority on the value.
 */

const STATUSES: IncidentStatus[] = ['NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

const IMPACTS: IncidentImpact[] = ['EXTENSIVE', 'SIGNIFICANT', 'MINOR'];
const URGENCIES: IncidentUrgency[] = ['HIGH', 'MEDIUM', 'LOW'];

const IMPACT_LABELS: Record<IncidentImpact, string> = {
  EXTENSIVE: 'Extensive — many users or a critical service',
  SIGNIFICANT: 'Significant — a team or a major function',
  MINOR: 'Minor — an individual or a workaround exists',
};

export function IncidentsPage() {
  const [status, setStatus] = useState<IncidentStatus | ''>('');
  const [majorOnly, setMajorOnly] = useState(false);
  const [reporting, setReporting] = useState(false);

  const incidents = useQuery({
    queryKey: ['incidents', { status, majorOnly }],
    queryFn: ({ signal }) => listIncidents({ status: status || undefined, majorOnly }, signal),
  });

  return (
    <div className="space-y-8">
      <section aria-labelledby="incidents-heading">
        <h1 id="incidents-heading" className="text-2xl font-semibold text-content">
          Incidents
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Report and track disruption. Priority is derived from impact and urgency, so the most
          disruptive work surfaces first.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => setReporting((value) => !value)}
          className="rounded bg-brand px-4 py-2 text-content-inverted"
        >
          {reporting ? 'Close' : 'Report an incident'}
        </button>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as IncidentStatus | '')}
            className="rounded border border-border bg-surface px-3 py-1.5 text-content"
          >
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={majorOnly}
            onChange={(event) => setMajorOnly(event.target.checked)}
          />
          <span className="text-content-muted">Major only</span>
        </label>
      </div>

      {reporting && <ReportIncidentForm onDone={() => setReporting(false)} />}

      {incidents.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading incidents…
        </p>
      )}
      {incidents.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(incidents.error)}
        </p>
      )}
      {incidents.isSuccess && incidents.data.items.length === 0 && (
        <p className="text-sm text-content-muted">No incidents reported.</p>
      )}

      {incidents.isSuccess && incidents.data.items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {incidents.data.items.map((item) => (
            <IncidentRow key={item.id} incident={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IncidentRow({ incident }: { incident: IncidentSummary }) {
  return (
    <li>
      <Link
        to={`/incidents/${incident.id}`}
        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted"
      >
        <span>
          <span className="font-mono text-xs text-content-muted">{incident.reference}</span>
          <span className="ml-2 font-medium text-content">{incident.title}</span>
          {incident.isMajor && (
            <StatusBadge tone="danger">
              <span className="ml-2">MAJOR</span>
            </StatusBadge>
          )}
          <span className="mt-0.5 block text-sm text-content-muted">
            {incident.reporterName}
            {incident.assigneeName ? ` → ${incident.assigneeName}` : ' · unassigned'}
            {incident.teamName ? ` · ${incident.teamName}` : ''}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge tone={priorityTone(incident.priority)}>{incident.priority}</StatusBadge>
          <StatusBadge tone={incidentStatusTone(incident.status)}>{incident.status}</StatusBadge>
        </span>
      </Link>
    </li>
  );
}

function ReportIncidentForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [impact, setImpact] = useState<IncidentImpact>('SIGNIFICANT');
  const [urgency, setUrgency] = useState<IncidentUrgency>('MEDIUM');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: ({ signal }) => listTeams(signal),
  });

  const create = useMutation({
    mutationFn: () =>
      createIncident({
        title,
        description,
        impact,
        urgency,
        teamId: teamId || null,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      onDone();
      navigate(`/incidents/${result.incident.id}`);
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const preview = derivePriority(impact, urgency);

  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() && description.trim()) create.mutate();
      }}
    >
      <h2 className="text-lg font-semibold text-content">Report an incident</h2>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <label className="block space-y-1 text-sm">
        <span className="block font-medium text-content">What is broken?</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
        />
      </label>

      <label className="block space-y-1 text-sm">
        <span className="block font-medium text-content">Description</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Impact</span>
          <select
            value={impact}
            onChange={(event) => setImpact(event.target.value as IncidentImpact)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            {IMPACTS.map((value) => (
              <option key={value} value={value}>
                {IMPACT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Urgency</span>
          <select
            value={urgency}
            onChange={(event) => setUrgency(event.target.value as IncidentUrgency)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            {URGENCIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3 rounded border border-border bg-surface-muted px-3 py-2">
        <span className="text-sm text-content-muted">Derived priority</span>
        <StatusBadge tone={priorityTone(preview)}>{preview}</StatusBadge>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="block font-medium text-content">Team (optional)</span>
        <select
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
        >
          <option value="">Unassigned — routed at triage</option>
          {(teams.data?.items ?? []).map((team: TeamSummary) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        disabled={create.isPending || !title.trim() || !description.trim()}
        className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
      >
        {create.isPending ? 'Reporting…' : 'Report incident'}
      </button>
    </form>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.errors.length > 0) {
      return `${error.message} (${error.errors.map((detail) => detail.message).join('; ')})`;
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
