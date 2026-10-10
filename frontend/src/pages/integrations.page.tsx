import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createInboundEndpoint,
  createWebhookSubscription,
  getIntegrationHealth,
  listInboundDeadLetters,
  listInboundEndpoints,
  listIntegrationConfig,
  listOutboundDeadLetters,
  listWebhookEvents,
  listWebhookSubscriptions,
  retryInboundDeadLetter,
  retryOutboundDeadLetter,
  testIntegrationConfig,
  updateInboundEndpoint,
  updateIntegrationConfig,
  updateWebhookSubscription,
  type InboundEndpoint,
  type InboundEvent,
  type IntegrationConfig,
  type IntegrationHealth,
  type WebhookDelivery,
  type WebhookSubscription,
} from '../api/integrations.api';
import { ApiError } from '../api/client';
import { useAuth } from '../hooks/auth-context';
import { StatusBadge } from '../components/status-badge';

/**
 * Integration administration (docs/32 §4/§5/§12/§13).
 *
 * Three surfaces on one screen, because they are three views of the same concern and an
 * operator diagnosing a broken integration needs all of them without navigating:
 *
 *   - **Webhook subscriptions** — the event-driven outbound side (§4).
 *   - **Inbound endpoints** — the receive side (§5); the `key` is the `{provider}` path.
 *   - **Dead-letter viewer** — what failed, with an explicit retry (§13).
 *
 * Two non-negotiables this page respects:
 *
 *   1. A **secret is shown once**, in the response to the create that minted it, and never
 *      again. The UI surfaces it in a prominent one-time panel and then only ever shows a hint.
 *   2. The page **never decides scope or entitlement**. It hides controls the caller cannot
 *      use (`integration:manage`/`integration:retry`) so the screen is honest, but the server
 *      is the control and refuses independently.
 */
export function IntegrationsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('integration:manage');
  const canRetry = hasPermission('integration:retry');
  const canConfigure = hasPermission('admin:config');

  return (
    <div className="space-y-8">
      <section aria-labelledby="integrations-heading">
        <h1 id="integrations-heading" className="text-2xl font-semibold text-content">
          Integrations
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Outbound webhooks ServiceHub sends, inbound webhooks it receives, and the deliveries and
          events that failed. Exchanges are signed, idempotent and retried; failures are
          dead-lettered rather than dropped.
        </p>
      </section>

      <HealthBoardSection />
      <ConfigurationSection canConfigure={canConfigure} />
      <WebhookSubscriptionsSection canManage={canManage} />
      <InboundEndpointsSection canManage={canManage} />
      <DeadLetterSection canRetry={canRetry} />
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

function formatWhen(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * The health board (`docs/32` §13): last success, last error and dead-letter count per
 * integration, both directions. The server sorts unhealthy first and derives `healthy`, so
 * the board cannot disagree with the underlying rows.
 */
function HealthBoardSection() {
  const health = useQuery({
    queryKey: ['integration-health'],
    queryFn: ({ signal }) => getIntegrationHealth(signal),
    // A board is a live view; refresh it so a failure is visible without a manual reload.
    refetchInterval: 30_000,
  });

  const rows: IntegrationHealth[] = health.data?.integrations ?? [];
  const unhealthy = rows.filter((row) => !row.healthy).length;

  return (
    <section aria-labelledby="health-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 id="health-heading" className="text-lg font-semibold text-content">
          Health
        </h2>
        {health.isSuccess && rows.length > 0 && (
          <StatusBadge tone={unhealthy > 0 ? 'danger' : 'success'}>
            {unhealthy > 0 ? `${unhealthy} need attention` : 'All healthy'}
          </StatusBadge>
        )}
      </div>

      {health.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading health…
        </p>
      )}
      {health.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(health.error)}
        </p>
      )}
      {health.isSuccess && rows.length === 0 && (
        <p className="text-sm text-content-muted">
          No integrations configured yet. Outbound subscriptions and inbound endpoints appear here
          once they exist.
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-muted text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Integration
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Direction
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Health
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Last success
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Last error
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Dead-letters
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Error rate
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}:${row.id}`} className="border-t border-border">
                  <td className="px-3 py-2">
                    <p className="text-content">{row.name}</p>
                    <p className="max-w-xs break-all font-mono text-xs text-content-muted">
                      {row.detail}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-content-muted">
                    {row.kind === 'OUTBOUND_WEBHOOK' ? 'Outbound' : 'Inbound'}
                    {!row.enabled && <span className="ml-1 text-xs">(disabled)</span>}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={row.healthy ? 'success' : 'danger'}>
                      {row.healthy ? 'Healthy' : 'Failing'}
                    </StatusBadge>
                  </td>
                  <td className="px-3 py-2 text-xs text-content-muted">
                    {formatWhen(row.lastSuccessAt)}
                  </td>
                  <td className="px-3 py-2 text-xs text-content-muted">
                    {row.lastError ? (
                      <>
                        <span className="block">{formatWhen(row.lastErrorAt)}</span>
                        <span className="text-danger">{row.lastError}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.deadLettered > 0 ? (
                      <StatusBadge tone="danger">{row.deadLettered}</StatusBadge>
                    ) : (
                      <span className="text-content-muted">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-content-muted">{formatRate(row.errorRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A one-time secret panel. It is rendered only from a create response and never refetched. */
function SecretReveal({ label, value, path }: { label: string; value: string; path?: string }) {
  return (
    <div role="status" className="space-y-1 rounded border border-warning/40 bg-warning/10 p-3">
      <p className="text-sm font-medium text-content">
        {label} — copy it now; it is shown only once.
      </p>
      {path && (
        <p className="text-xs text-content-muted">
          Endpoint path: <code className="font-mono">{path}</code>
        </p>
      )}
      <code className="block break-all rounded bg-surface px-2 py-1 font-mono text-xs text-content">
        {value}
      </code>
    </div>
  );
}

function WebhookSubscriptionsSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);

  const events = useQuery({
    queryKey: ['webhook-events'],
    queryFn: ({ signal }) => listWebhookEvents(signal),
  });
  const subscriptions = useQuery({
    queryKey: ['webhook-subscriptions'],
    queryFn: ({ signal }) => listWebhookSubscriptions(signal),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions'] });

  const create = useMutation({
    mutationFn: () => createWebhookSubscription({ description, url, events: selected }),
    onSuccess: (data) => {
      setSecret(data.subscription.secret ?? null);
      setDescription('');
      setUrl('');
      setSelected([]);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: (input: { id: string; body: { enabled?: boolean; rotateSecret?: boolean } }) =>
      updateWebhookSubscription(input.id, input.body),
    onSuccess: invalidate,
  });

  function toggleEvent(event: string): void {
    setSelected((current) =>
      current.includes(event) ? current.filter((value) => value !== event) : [...current, event],
    );
  }

  return (
    <section aria-labelledby="webhooks-heading" className="space-y-4">
      <h2 id="webhooks-heading" className="text-lg font-semibold text-content">
        Webhook subscriptions
      </h2>

      {secret && <SecretReveal label="Signing secret" value={secret} />}
      <p className="text-xs text-content-muted">
        Payloads are signed with the subscription secret over the raw body; a receiver verifies the
        signature and the timestamp.
      </p>

      {subscriptions.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading subscriptions…
        </p>
      )}
      {subscriptions.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(subscriptions.error)}
        </p>
      )}
      {subscriptions.isSuccess && subscriptions.data.subscriptions.length === 0 && (
        <p className="text-sm text-content-muted">No subscriptions yet.</p>
      )}
      {subscriptions.isSuccess && subscriptions.data.subscriptions.length > 0 && (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-muted text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Description
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  URL
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Events
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Dead-letters
                </th>
                {canManage && (
                  <th scope="col" className="px-3 py-2 font-medium">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {subscriptions.data.subscriptions.map((subscription: WebhookSubscription) => (
                <tr key={subscription.id} className="border-t border-border">
                  <td className="px-3 py-2 text-content">{subscription.description}</td>
                  <td className="max-w-xs break-all px-3 py-2 font-mono text-xs text-content-muted">
                    {subscription.url}
                  </td>
                  <td className="px-3 py-2 text-content-muted">
                    {subscription.events.length} event{subscription.events.length === 1 ? '' : 's'}
                    <span className="ml-1 text-xs">({subscription.secretHint})</span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={subscription.enabled ? 'success' : 'neutral'}>
                      {subscription.enabled ? 'Enabled' : 'Disabled'}
                    </StatusBadge>
                  </td>
                  <td className="px-3 py-2">
                    {subscription.deadLetterCount > 0 ? (
                      <StatusBadge tone="danger">{subscription.deadLetterCount}</StatusBadge>
                    ) : (
                      <span className="text-content-muted">0</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            update.mutate({
                              id: subscription.id,
                              body: { enabled: !subscription.enabled },
                            })
                          }
                          className="rounded border border-border px-2 py-1 text-xs text-content"
                        >
                          {subscription.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            update.mutate({ id: subscription.id, body: { rotateSecret: true } })
                          }
                          className="rounded border border-border px-2 py-1 text-xs text-content"
                        >
                          Rotate secret
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {update.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(update.error)}
        </p>
      )}

      {canManage && (
        <form
          className="space-y-3 rounded-lg border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <h3 className="text-sm font-semibold text-content">New subscription</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-content-muted">Description</span>
              <input
                required
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="rounded border border-border bg-surface px-3 py-1.5 text-content"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-content-muted">Endpoint URL (HTTPS)</span>
              <input
                required
                type="url"
                placeholder="https://hooks.example.com/servicehub"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-xs text-content"
              />
            </label>
          </div>

          <fieldset className="space-y-1">
            <legend className="text-sm text-content-muted">Events</legend>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-border p-2">
              {(events.data?.events ?? []).map((event) => (
                <label key={event} className="flex items-center gap-2 text-xs text-content">
                  <input
                    type="checkbox"
                    checked={selected.includes(event)}
                    onChange={() => toggleEvent(event)}
                  />
                  <span className="font-mono">{event}</span>
                </label>
              ))}
              {events.isError && (
                <p role="alert" className="text-xs text-danger">
                  {messageFor(events.error)}
                </p>
              )}
            </div>
          </fieldset>

          <button
            type="submit"
            disabled={create.isPending || selected.length === 0}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create subscription'}
          </button>
          {create.isError && (
            <p role="alert" className="text-sm text-danger">
              {messageFor(create.error)}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function InboundEndpointsSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [provider, setProvider] = useState('');
  const [created, setCreated] = useState<{ secret: string; path: string } | null>(null);

  const endpoints = useQuery({
    queryKey: ['inbound-endpoints'],
    queryFn: ({ signal }) => listInboundEndpoints(signal),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['inbound-endpoints'] });

  const create = useMutation({
    mutationFn: () => createInboundEndpoint({ key, provider }),
    onSuccess: (data) => {
      setCreated({
        secret: data.endpoint.secret ?? '',
        path: data.endpoint.path ?? '',
      });
      setKey('');
      setProvider('');
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: (input: { id: string; body: { enabled?: boolean; rotateSecret?: boolean } }) =>
      updateInboundEndpoint(input.id, input.body),
    onSuccess: invalidate,
  });

  return (
    <section aria-labelledby="inbound-heading" className="space-y-4">
      <h2 id="inbound-heading" className="text-lg font-semibold text-content">
        Inbound endpoints
      </h2>

      {created && (
        <SecretReveal label="Verification secret" value={created.secret} path={created.path} />
      )}
      <p className="text-xs text-content-muted">
        A provider posts to the endpoint path. Deliveries are verified against the signature,
        recorded, acknowledged, then processed; unsigned or stale deliveries are refused.
      </p>

      {endpoints.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading endpoints…
        </p>
      )}
      {endpoints.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(endpoints.error)}
        </p>
      )}
      {endpoints.isSuccess && endpoints.data.endpoints.length === 0 && (
        <p className="text-sm text-content-muted">No inbound endpoints yet.</p>
      )}
      {endpoints.isSuccess && endpoints.data.endpoints.length > 0 && (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-muted text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Key
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Provider
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Dead-letters
                </th>
                {canManage && (
                  <th scope="col" className="px-3 py-2 font-medium">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {endpoints.data.endpoints.map((endpoint: InboundEndpoint) => (
                <tr key={endpoint.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-content">{endpoint.key}</td>
                  <td className="px-3 py-2 text-content">{endpoint.provider}</td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={endpoint.enabled ? 'success' : 'neutral'}>
                      {endpoint.enabled ? 'Enabled' : 'Disabled'}
                    </StatusBadge>
                  </td>
                  <td className="px-3 py-2">
                    {endpoint.deadLetterCount > 0 ? (
                      <StatusBadge tone="danger">{endpoint.deadLetterCount}</StatusBadge>
                    ) : (
                      <span className="text-content-muted">0</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            update.mutate({ id: endpoint.id, body: { enabled: !endpoint.enabled } })
                          }
                          className="rounded border border-border px-2 py-1 text-xs text-content"
                        >
                          {endpoint.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            update.mutate({ id: endpoint.id, body: { rotateSecret: true } })
                          }
                          className="rounded border border-border px-2 py-1 text-xs text-content"
                        >
                          Rotate secret
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {update.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(update.error)}
        </p>
      )}

      {canManage && (
        <form
          className="space-y-3 rounded-lg border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <h3 className="text-sm font-semibold text-content">New inbound endpoint</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-content-muted">Key (path segment)</span>
              <input
                required
                pattern="[a-z0-9][a-z0-9-]*"
                placeholder="acme-tickets"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-xs text-content"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-content-muted">Provider</span>
              <input
                required
                placeholder="Acme Tickets"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                className="rounded border border-border bg-surface px-3 py-1.5 text-content"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create endpoint'}
          </button>
          {create.isError && (
            <p role="alert" className="text-sm text-danger">
              {messageFor(create.error)}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function DeadLetterSection({ canRetry }: { canRetry: boolean }) {
  const queryClient = useQueryClient();

  const outbound = useQuery({
    queryKey: ['webhook-dead-letters'],
    queryFn: ({ signal }) => listOutboundDeadLetters(signal),
  });
  const inbound = useQuery({
    queryKey: ['inbound-dead-letters'],
    queryFn: ({ signal }) => listInboundDeadLetters(signal),
  });

  const retryOutbound = useMutation({
    mutationFn: (id: string) => retryOutboundDeadLetter(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['webhook-dead-letters'] });
      void queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions'] });
    },
  });
  const retryInbound = useMutation({
    mutationFn: (id: string) => retryInboundDeadLetter(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inbound-dead-letters'] });
      void queryClient.invalidateQueries({ queryKey: ['inbound-endpoints'] });
    },
  });

  return (
    <section aria-labelledby="dead-letters-heading" className="space-y-4">
      <h2 id="dead-letters-heading" className="text-lg font-semibold text-content">
        Dead-letter viewer
      </h2>
      <p className="text-xs text-content-muted">
        A delivery or event that exhausted its retries. The raw payload is retained for a bounded
        window; retrying requeues it for another attempt chain and is recorded.
      </p>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-content">Outbound deliveries</h3>
        {outbound.isPending && (
          <p role="status" className="text-sm text-content-muted">
            Loading…
          </p>
        )}
        {outbound.isError && (
          <p role="alert" className="text-sm text-danger">
            {messageFor(outbound.error)}
          </p>
        )}
        {outbound.isSuccess && outbound.data.deliveries.length === 0 && (
          <p className="text-sm text-content-muted">No failed deliveries.</p>
        )}
        {outbound.isSuccess && outbound.data.deliveries.length > 0 && (
          <ul className="space-y-2">
            {outbound.data.deliveries.map((delivery: WebhookDelivery) => (
              <li
                key={delivery.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-content">{delivery.eventType}</p>
                  <p className="text-xs text-content-muted">
                    {delivery.attempts} attempt{delivery.attempts === 1 ? '' : 's'}
                    {delivery.lastError ? ` · ${delivery.lastError}` : ''}
                  </p>
                </div>
                {canRetry && (
                  <button
                    type="button"
                    onClick={() => retryOutbound.mutate(delivery.id)}
                    disabled={retryOutbound.isPending}
                    className="rounded border border-border px-2 py-1 text-xs text-content disabled:opacity-60"
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {retryOutbound.isError && (
          <p role="alert" className="text-sm text-danger">
            {messageFor(retryOutbound.error)}
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-content">Inbound events</h3>
        {inbound.isPending && (
          <p role="status" className="text-sm text-content-muted">
            Loading…
          </p>
        )}
        {inbound.isError && (
          <p role="alert" className="text-sm text-danger">
            {messageFor(inbound.error)}
          </p>
        )}
        {inbound.isSuccess && inbound.data.deliveries.length === 0 && (
          <p className="text-sm text-content-muted">No failed inbound events.</p>
        )}
        {inbound.isSuccess && inbound.data.deliveries.length > 0 && (
          <ul className="space-y-2">
            {inbound.data.deliveries.map((event: InboundEvent) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-content">
                    {event.eventType ?? event.providerEventId}
                  </p>
                  <p className="text-xs text-content-muted">
                    {event.attempts} attempt{event.attempts === 1 ? '' : 's'}
                    {event.lastError ? ` · ${event.lastError}` : ''}
                  </p>
                </div>
                {canRetry && (
                  <button
                    type="button"
                    onClick={() => retryInbound.mutate(event.id)}
                    disabled={retryInbound.isPending}
                    className="rounded border border-border px-2 py-1 text-xs text-content disabled:opacity-60"
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {retryInbound.isError && (
          <p role="alert" className="text-sm text-danger">
            {messageFor(retryInbound.error)}
          </p>
        )}
      </div>
    </section>
  );
}

/** The reliability knobs a tenant may tune (docs/32 §8), with the label and explanation. */
const RELIABILITY_FIELDS: ReadonlyArray<{
  name: keyof IntegrationConfig['config'];
  label: string;
  hint: string;
}> = [
  {
    name: 'breakerFailureThreshold',
    label: 'Breaker threshold',
    hint: 'Consecutive failures before the circuit opens.',
  },
  { name: 'breakerOpenMs', label: 'Breaker cooldown (ms)', hint: 'How long it stays open.' },
  {
    name: 'breakerHalfOpenSuccesses',
    label: 'Probe successes',
    hint: 'Successes needed to close.',
  },
  { name: 'bulkheadMaxConcurrent', label: 'Max concurrent', hint: 'In-flight calls allowed.' },
  { name: 'bulkheadMaxQueue', label: 'Max queued', hint: 'Waiters before rejection.' },
  { name: 'bulkheadQueueTimeoutMs', label: 'Queue wait (ms)', hint: 'Longest a call waits.' },
  { name: 'retryMaxAttempts', label: 'Max attempts', hint: 'Retries before dead-lettering.' },
  { name: 'timeoutMs', label: 'Call timeout (ms)', hint: 'Never wait forever.' },
];

/**
 * Integration configuration (`docs/32` §11/§12/§13).
 *
 * The catalogue is served by the backend, so this screen never hard-codes which integrations
 * exist. A caller without `admin:config` still sees the effective settings — reading is
 * `integration:read` — but every control is hidden, and the server refuses independently.
 *
 * The credential field is a **reference**, not a secret: the placeholder is `env:NAME`, and the
 * API rejects a value, so the screen teaches the correct shape rather than accepting one and
 * failing later.
 */
function ConfigurationSection({ canConfigure }: { canConfigure: boolean }) {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ['integration-config'],
    queryFn: ({ signal }) => listIntegrationConfig(signal),
  });

  const rows: IntegrationConfig[] = configQuery.data?.integrations ?? [];

  return (
    <section aria-labelledby="config-heading" className="space-y-4">
      <h2 id="config-heading" className="text-lg font-semibold text-content">
        Configuration
      </h2>
      <p className="max-w-3xl text-sm text-content-muted">
        Enable each integration and tune how it fails. External calls run behind a circuit breaker
        and a bulkhead, so one failed remote fails fast instead of spending every other
        integration’s capacity. Credentials are injected at runtime — a reference names where the
        secret lives, never the secret itself.
      </p>

      {configQuery.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading configuration…
        </p>
      )}
      {configQuery.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(configQuery.error)}
        </p>
      )}
      {rows.map((row) => (
        <IntegrationConfigCard
          key={`${row.key}:${row.updatedAt ?? 'default'}`}
          row={row}
          canConfigure={canConfigure}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['integration-config'] })}
        />
      ))}
    </section>
  );
}

function IntegrationConfigCard({
  row,
  canConfigure,
  onSaved,
}: {
  row: IntegrationConfig;
  canConfigure: boolean;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(row.enabled);
  const [draft, setDraft] = useState(row.config);
  const [credentialRef, setCredentialRef] = useState(row.credentialRef ?? '');

  const save = useMutation({
    mutationFn: () =>
      updateIntegrationConfig(row.key, {
        enabled,
        config: draft,
        // Send the reference only when it changed, so an untouched field cannot clear it.
        ...(credentialRef !== (row.credentialRef ?? '')
          ? { credentialRef: credentialRef.trim() === '' ? null : credentialRef.trim() }
          : {}),
      }),
    onSuccess: onSaved,
  });

  const test = useMutation({
    mutationFn: () => testIntegrationConfig(row.key),
    onSuccess: onSaved,
  });

  return (
    <div className="space-y-4 rounded border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-content">{row.name}</h3>
          <p className="max-w-2xl text-xs text-content-muted">{row.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone={enabled ? 'success' : 'neutral'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </StatusBadge>
          {row.lastTestStatus && (
            <StatusBadge tone={row.lastTestStatus === 'OK' ? 'success' : 'danger'}>
              Test: {row.lastTestStatus}
            </StatusBadge>
          )}
        </div>
      </div>

      <fieldset disabled={!canConfigure} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              aria-label={`${row.name} enabled`}
            />
            Enabled
          </label>

          {row.usesCredential && (
            <label className="flex flex-col gap-1 text-sm text-content">
              Credential reference
              <input
                type="text"
                value={credentialRef}
                onChange={(event) => setCredentialRef(event.target.value)}
                placeholder={row.credentialRefExample}
                aria-label={`${row.name} credential reference`}
                className="w-72 rounded border border-border bg-surface px-2 py-1 font-mono text-xs text-content"
              />
            </label>
          )}
          {row.usesCredential && (
            <p className="text-xs text-content-muted">
              {row.credentialConfigured
                ? 'A runtime adapter is present in this environment.'
                : 'No runtime adapter is configured in this environment.'}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {RELIABILITY_FIELDS.map((field) => (
            <label key={field.name} className="flex flex-col gap-1 text-xs text-content-muted">
              {field.label}
              <input
                type="number"
                min={0}
                value={draft[field.name]}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [field.name]: Number.isFinite(event.target.valueAsNumber)
                      ? event.target.valueAsNumber
                      : current[field.name],
                  }))
                }
                aria-label={`${row.name} ${field.label}`}
                title={field.hint}
                className="rounded border border-border bg-surface px-2 py-1 text-sm text-content"
              />
            </label>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!canConfigure || save.isPending}
            className="rounded bg-brand px-3 py-1 text-sm text-content-inverted disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : 'Save configuration'}
          </button>
          <button
            type="button"
            onClick={() => test.mutate()}
            disabled={!canConfigure || test.isPending || !row.testable}
            title={
              row.testable
                ? 'Check that a runtime adapter is present'
                : 'Reachability is proved per endpoint by delivery'
            }
            className="rounded border border-border px-3 py-1 text-sm text-content disabled:opacity-60"
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </fieldset>

      {(save.isError || test.isError) && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(save.error ?? test.error)}
        </p>
      )}
      {test.isSuccess && (
        <p role="status" className="text-sm text-content-muted">
          {test.data.result.status}: {test.data.result.message}
        </p>
      )}
      {row.lastTestError && <p className="text-xs text-danger">{row.lastTestError}</p>}
    </div>
  );
}
