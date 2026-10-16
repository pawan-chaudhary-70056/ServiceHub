import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getItem, listItems, type CatalogItemSummary } from '../api/catalog.api';
import {
  createRequest,
  listRequests,
  type RequestStatus,
  type RequestSummary,
} from '../api/requests.api';
import { SlaIndicator } from '../components/sla-indicator';
import { StatusBadge } from '../components/status-badge';
import { priorityTone, statusTone } from '../utils/request-tones';

/**
 * Service requests list and the raise form (docs/22 §12).
 *
 * The list is scoped server-side to what the caller may read (own / team / any), so the
 * screen shows whatever the API returns without re-implementing scope — a client-side
 * scope filter would be both wrong and redundant (docs/07 §6).
 */

const STATUSES: RequestStatus[] = [
  'NEW',
  'TRIAGED',
  'APPROVAL_PENDING',
  'APPROVED',
  'REJECTED',
  'IN_PROGRESS',
  'FULFILLED',
  'CLOSED',
  'CANCELLED',
];

export function RequestsPage() {
  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [raising, setRaising] = useState(false);

  const requests = useQuery({
    queryKey: ['requests', { status }],
    queryFn: ({ signal }) => listRequests(status ? { status } : {}, signal),
  });

  return (
    <div className="space-y-8">
      <section aria-labelledby="requests-heading">
        <h1 id="requests-heading" className="text-2xl font-semibold text-content">
          Requests
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Track the work you have raised and what your team is handling.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => setRaising((value) => !value)}
          className="rounded bg-brand px-4 py-2 text-content-inverted"
        >
          {raising ? 'Close' : 'Raise a request'}
        </button>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as RequestStatus | '')}
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
      </div>

      {raising && <RaiseRequestForm onDone={() => setRaising(false)} />}

      {requests.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading requests…
        </p>
      )}
      {requests.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(requests.error)}
        </p>
      )}
      {requests.isSuccess && requests.data.items.length === 0 && (
        <p className="text-sm text-content-muted">No requests yet.</p>
      )}

      {requests.isSuccess && requests.data.items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {requests.data.items.map((item) => (
            <RequestRow key={item.id} request={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RequestRow({ request }: { request: RequestSummary }) {
  return (
    <li>
      <Link
        to={`/requests/${request.id}`}
        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted"
      >
        <span>
          <span className="font-mono text-xs text-content-muted">{request.reference}</span>
          <span className="ml-2 font-medium text-content">{request.title}</span>
          <span className="mt-0.5 block text-sm text-content-muted">
            {request.catalogItemName} · {request.requesterName}
            {request.assigneeName ? ` → ${request.assigneeName}` : ''}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {/* `docs/25` §12 and `docs/22` §14 AC5: the SLA state is visible in the list, so a
              reviewer can triage by urgency without opening each record. */}
          <SlaIndicator sla={request.sla} />
          <StatusBadge tone={priorityTone(request.priority)}>{request.priority}</StatusBadge>
          <StatusBadge tone={statusTone(request.status)}>{request.status}</StatusBadge>
        </span>
      </Link>
    </li>
  );
}

function RaiseRequestForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [itemId, setItemId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const items = useQuery({
    queryKey: ['catalog', 'items', 'active'],
    queryFn: ({ signal }) => listItems({ status: 'ACTIVE' }, signal),
  });

  const detail = useQuery({
    queryKey: ['catalog', 'item', itemId],
    queryFn: ({ signal }) => getItem(itemId, signal),
    enabled: itemId !== '',
  });

  const create = useMutation({
    mutationFn: () =>
      createRequest({
        catalogItemId: itemId,
        title,
        description: description || null,
        fields,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      onDone();
      navigate(`/requests/${result.request.id}`);
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (itemId && title.trim()) create.mutate();
      }}
    >
      <h2 className="text-lg font-semibold text-content">Raise a request</h2>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="block font-medium text-content">Service</span>
          <select
            value={itemId}
            onChange={(event) => {
              setItemId(event.target.value);
              setFields({});
            }}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            <option value="">Select a service…</option>
            {(items.data?.items ?? []).map((item: CatalogItemSummary) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="block font-medium text-content">What do you need?</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="block font-medium text-content">More detail (optional)</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>

        {(detail.data?.item.fields ?? []).map((field) => (
          <label key={field.id} className="space-y-1 text-sm sm:col-span-2">
            <span className="block font-medium text-content">
              {field.label}
              {field.isRequired && <span className="ml-1 text-danger">*</span>}
            </span>
            <input
              value={fields[field.key] ?? ''}
              onChange={(event) => setFields({ ...fields, [field.key]: event.target.value })}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
          </label>
        ))}
      </div>

      <button
        type="submit"
        disabled={create.isPending || !itemId || !title.trim()}
        className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
      >
        {create.isPending ? 'Submitting…' : 'Submit request'}
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
