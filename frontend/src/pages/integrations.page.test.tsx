import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { IntegrationsPage } from './integrations.page';

/**
 * Integration admin page tests (docs/32 §13, docs/37 §2).
 *
 * The behaviour under test is the entitlement boundary and the one-time secret: manage and
 * retry controls appear only for a caller who holds the grant, and a minted secret is surfaced
 * once from the create response and never otherwise.
 */

const getIntegrationHealth = vi.fn();
const listWebhookEvents = vi.fn();
const listWebhookSubscriptions = vi.fn();
const listInboundEndpoints = vi.fn();
const listOutboundDeadLetters = vi.fn();
const listInboundDeadLetters = vi.fn();
const createWebhookSubscription = vi.fn();
const createInboundEndpoint = vi.fn();
const updateWebhookSubscription = vi.fn();
const updateInboundEndpoint = vi.fn();
const retryOutboundDeadLetter = vi.fn();
const retryInboundDeadLetter = vi.fn();
const listIntegrationConfig = vi.fn();
const updateIntegrationConfig = vi.fn();
const testIntegrationConfig = vi.fn();

vi.mock('../api/integrations.api', async () => {
  const actual =
    await vi.importActual<typeof import('../api/integrations.api')>('../api/integrations.api');
  return {
    ...actual,
    getIntegrationHealth: (...args: unknown[]) => getIntegrationHealth(...args),
    listWebhookEvents: (...args: unknown[]) => listWebhookEvents(...args),
    listWebhookSubscriptions: (...args: unknown[]) => listWebhookSubscriptions(...args),
    listInboundEndpoints: (...args: unknown[]) => listInboundEndpoints(...args),
    listOutboundDeadLetters: (...args: unknown[]) => listOutboundDeadLetters(...args),
    listInboundDeadLetters: (...args: unknown[]) => listInboundDeadLetters(...args),
    createWebhookSubscription: (...args: unknown[]) => createWebhookSubscription(...args),
    createInboundEndpoint: (...args: unknown[]) => createInboundEndpoint(...args),
    updateWebhookSubscription: (...args: unknown[]) => updateWebhookSubscription(...args),
    updateInboundEndpoint: (...args: unknown[]) => updateInboundEndpoint(...args),
    retryOutboundDeadLetter: (...args: unknown[]) => retryOutboundDeadLetter(...args),
    retryInboundDeadLetter: (...args: unknown[]) => retryInboundDeadLetter(...args),
    listIntegrationConfig: (...args: unknown[]) => listIntegrationConfig(...args),
    updateIntegrationConfig: (...args: unknown[]) => updateIntegrationConfig(...args),
    testIntegrationConfig: (...args: unknown[]) => testIntegrationConfig(...args),
  };
});

const EMAIL_CONFIG = {
  key: 'email',
  name: 'Email provider',
  description: 'Outbound notifications and account email (docs/29).',
  direction: 'outbound' as const,
  testable: true,
  usesCredential: true,
  enabled: true,
  config: {
    breakerFailureThreshold: 5,
    breakerOpenMs: 30_000,
    breakerHalfOpenSuccesses: 2,
    bulkheadMaxConcurrent: 10,
    bulkheadMaxQueue: 200,
    bulkheadQueueTimeoutMs: 5_000,
    retryMaxAttempts: 5,
    timeoutMs: 10_000,
  },
  defaults: {
    breakerFailureThreshold: 5,
    breakerOpenMs: 30_000,
    breakerHalfOpenSuccesses: 2,
    bulkheadMaxConcurrent: 10,
    bulkheadMaxQueue: 200,
    bulkheadQueueTimeoutMs: 5_000,
    retryMaxAttempts: 5,
    timeoutMs: 10_000,
  },
  credentialRef: null as string | null,
  credentialConfigured: true,
  credentialRefExample: 'env:SENDGRID_API_KEY',
  lastTestedAt: null as string | null,
  lastTestStatus: null as 'OK' | 'FAILED' | null,
  lastTestError: null as string | null,
  updatedAt: null as string | null,
};

function renderPage(permissions: string[]) {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Ada Admin',
      email: 'admin@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions,
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) => permissions.includes(permission),
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IntegrationsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getIntegrationHealth.mockResolvedValue({
    integrations: [
      {
        id: 'sub-1',
        kind: 'OUTBOUND_WEBHOOK',
        name: 'Downstream ticketing',
        detail: 'https://hooks.example.test/inbound',
        enabled: true,
        lastSuccessAt: new Date().toISOString(),
        lastErrorAt: null,
        lastError: null,
        succeeded: 8,
        failed: 0,
        deadLettered: 2,
        errorRate: 0,
        healthy: false,
      },
      {
        id: 'ep-1',
        kind: 'INBOUND_WEBHOOK',
        name: 'Acme Tickets',
        detail: 'acme-tickets',
        enabled: true,
        lastSuccessAt: new Date().toISOString(),
        lastErrorAt: null,
        lastError: null,
        succeeded: 3,
        failed: 0,
        deadLettered: 0,
        errorRate: 0,
        healthy: true,
      },
    ],
  });
  listWebhookEvents.mockResolvedValue({ events: ['notification.request.created'] });
  listWebhookSubscriptions.mockResolvedValue({
    subscriptions: [
      {
        id: 'sub-1',
        description: 'Downstream ticketing',
        url: 'https://hooks.example.test/inbound',
        events: ['notification.request.created'],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        secretHint: '••••abcd',
        deadLetterCount: 2,
      },
    ],
  });
  listInboundEndpoints.mockResolvedValue({
    endpoints: [
      {
        id: 'ep-1',
        key: 'acme-tickets',
        provider: 'Acme Tickets',
        enabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        secretHint: '••••wxyz',
        deadLetterCount: 1,
      },
    ],
  });
  listOutboundDeadLetters.mockResolvedValue({
    deliveries: [
      {
        id: 'dlq-1',
        subscriptionId: 'sub-1',
        eventId: 'evt-1',
        eventType: 'notification.request.created',
        status: 'DEAD_LETTER',
        attempts: 5,
        responseStatus: 503,
        lastError: 'Subscriber failed to accept the delivery (HTTP 503).',
        nextAttemptAt: null,
        deliveredAt: null,
        createdAt: new Date().toISOString(),
      },
    ],
    total: 1,
  });
  listInboundDeadLetters.mockResolvedValue({
    deliveries: [
      {
        id: 'idq-1',
        endpointId: 'ep-1',
        providerEventId: 'p-1',
        eventType: 'ticket.broken',
        status: 'DEAD_LETTER',
        attempts: 5,
        lastError: 'Handler could not process the event.',
        receivedAt: new Date().toISOString(),
        processedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
    total: 1,
  });
  retryOutboundDeadLetter.mockResolvedValue({ delivery: { id: 'dlq-1', status: 'PENDING' } });
  retryInboundDeadLetter.mockResolvedValue({ event: { id: 'idq-1', status: 'RECEIVED' } });
  listIntegrationConfig.mockResolvedValue({ integrations: [{ ...EMAIL_CONFIG }] });
  updateIntegrationConfig.mockResolvedValue({
    integration: { ...EMAIL_CONFIG, enabled: false },
  });
  testIntegrationConfig.mockResolvedValue({
    result: {
      key: 'email',
      status: 'OK',
      message: 'Email provider is configured and a runtime adapter is present.',
      checkedAt: new Date().toISOString(),
    },
  });
});

describe('IntegrationsPage', () => {
  it('lists subscriptions and inbound endpoints with their status', async () => {
    renderPage(['integration:read']);

    // These names also appear on the health board, so assert presence rather than uniqueness.
    expect(await screen.findAllByText('Downstream ticketing')).not.toHaveLength(0);
    expect(screen.getAllByText('acme-tickets').length).toBeGreaterThan(0);
    // Status badges are no longer unique on the page: the configuration section carries one
    // per integration as well. Assert the states render, not that each appears once.
    expect(screen.getAllByText('Enabled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
  });

  it('hides manage controls without integration:manage and shows them with it', async () => {
    const { unmount } = renderPage(['integration:read']);
    await screen.findAllByText('Downstream ticketing');
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create subscription' })).toBeNull();
    unmount();

    renderPage(['integration:read', 'integration:manage']);
    expect(await screen.findByRole('button', { name: 'Create subscription' })).toBeInTheDocument();
    // The list loads asynchronously; wait for a row before asserting its controls.
    await screen.findAllByText('Downstream ticketing');
    expect(screen.getAllByRole('button', { name: 'Rotate secret' }).length).toBeGreaterThan(0);
  });

  it('shows a minted secret once, in the create response only', async () => {
    createWebhookSubscription.mockResolvedValue({
      subscription: { id: 'sub-2', secret: 'whsec_brand_new_secret', secretHint: '••••cret' },
    });
    renderPage(['integration:read', 'integration:manage']);

    await userEvent.type(await screen.findByLabelText('Description'), 'Billing sync');
    await userEvent.type(
      screen.getByLabelText('Endpoint URL (HTTPS)'),
      'https://hooks.example.test/billing',
    );
    await userEvent.click(screen.getByLabelText('notification.request.created'));
    await userEvent.click(screen.getByRole('button', { name: 'Create subscription' }));

    expect(await screen.findByText(/shown only once/)).toBeInTheDocument();
    expect(screen.getByText('whsec_brand_new_secret')).toBeInTheDocument();
    expect(createWebhookSubscription).toHaveBeenCalledWith({
      description: 'Billing sync',
      url: 'https://hooks.example.test/billing',
      events: ['notification.request.created'],
    });
  });

  it('lists dead-letters and retries one when the caller holds integration:retry', async () => {
    renderPage(['integration:read', 'integration:retry']);

    expect(await screen.findByText('ticket.broken')).toBeInTheDocument();
    expect(screen.getByText('notification.request.created')).toBeInTheDocument();

    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons).toHaveLength(2);
    await userEvent.click(retryButtons[0]!);
    await waitFor(() => expect(retryOutboundDeadLetter).toHaveBeenCalledWith('dlq-1'));
  });

  it('hides retry controls without integration:retry', async () => {
    renderPage(['integration:read']);
    await screen.findByText('ticket.broken');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('renders the health board with last success, last error and a dead-letter count', async () => {
    renderPage(['integration:read']);

    // Unhealthy first: the summary badge and the per-row state both derive from the server.
    expect(await screen.findByText('1 need attention')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Failing')).toBeInTheDocument();
    // Both directions appear on one board.
    expect(screen.getByText('Outbound')).toBeInTheDocument();
    expect(screen.getByText('Inbound')).toBeInTheDocument();
    expect(screen.getAllByText('Downstream ticketing').length).toBeGreaterThan(0);
  });

  it('shows an "all healthy" summary when nothing needs attention', async () => {
    getIntegrationHealth.mockResolvedValue({
      integrations: [
        {
          id: 'ep-1',
          kind: 'INBOUND_WEBHOOK',
          name: 'Acme Tickets',
          detail: 'acme-tickets',
          enabled: true,
          lastSuccessAt: new Date().toISOString(),
          lastErrorAt: null,
          lastError: null,
          succeeded: 3,
          failed: 0,
          deadLettered: 0,
          errorRate: 0,
          healthy: true,
        },
      ],
    });
    renderPage(['integration:read']);
    expect(await screen.findByText('All healthy')).toBeInTheDocument();
  });

  it('creates an inbound endpoint and reveals its path and secret once', async () => {
    createInboundEndpoint.mockResolvedValue({
      endpoint: {
        id: 'ep-2',
        key: 'billing-hook',
        provider: 'Billing',
        secret: 'whsec_inbound_brand_new',
        path: '/api/v1/webhooks/inbound/billing-hook',
      },
    });
    renderPage(['integration:read', 'integration:manage']);

    await userEvent.type(await screen.findByLabelText('Key (path segment)'), 'billing-hook');
    await userEvent.type(screen.getByLabelText('Provider'), 'Billing');
    await userEvent.click(screen.getByRole('button', { name: 'Create endpoint' }));

    expect(await screen.findByText('whsec_inbound_brand_new')).toBeInTheDocument();
    expect(screen.getByText('/api/v1/webhooks/inbound/billing-hook')).toBeInTheDocument();
    expect(createInboundEndpoint).toHaveBeenCalledWith({
      key: 'billing-hook',
      provider: 'Billing',
    });
  });

  it('rotates a webhook signing secret through the API', async () => {
    updateWebhookSubscription.mockResolvedValue({ subscription: { id: 'sub-1' } });
    renderPage(['integration:read', 'integration:manage']);

    await screen.findAllByText('Downstream ticketing');
    await userEvent.click(screen.getAllByRole('button', { name: 'Rotate secret' })[0]!);

    await waitFor(() =>
      expect(updateWebhookSubscription).toHaveBeenCalledWith('sub-1', { rotateSecret: true }),
    );
  });

  it('rotates an inbound verification secret through the API', async () => {
    updateInboundEndpoint.mockResolvedValue({ endpoint: { id: 'ep-1' } });
    renderPage(['integration:read', 'integration:manage']);

    await screen.findAllByText('acme-tickets');
    // The inbound row's rotate button is the second one on the page (subscriptions come first).
    await userEvent.click(screen.getAllByRole('button', { name: 'Rotate secret' })[1]!);

    await waitFor(() =>
      expect(updateInboundEndpoint).toHaveBeenCalledWith('ep-1', { rotateSecret: true }),
    );
  });

  it('renders the integration catalogue and disables configuration without admin:config', async () => {
    renderPage(['integration:read']);

    expect(await screen.findByText('Email provider')).toBeInTheDocument();
    // The reference is a location, not a secret; the placeholder teaches the shape.
    expect(screen.getByPlaceholderText('env:SENDGRID_API_KEY')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  });

  it('saves the enabled flag and reliability tuning when the caller holds admin:config', async () => {
    renderPage(['integration:read', 'admin:config']);

    const save = await screen.findByRole('button', { name: 'Save configuration' });
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() =>
      expect(updateIntegrationConfig).toHaveBeenCalledWith('email', {
        enabled: true,
        config: EMAIL_CONFIG.config,
      }),
    );
  });

  it('tests a connection and reports the outcome', async () => {
    renderPage(['integration:read', 'admin:config']);

    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(testIntegrationConfig).toHaveBeenCalledWith('email'));
    // Matched from the start of the rendered status line, so it is the test outcome and not
    // the card's static "a runtime adapter is present" note.
    expect(await screen.findByText(/^OK: Email provider is configured/)).toBeInTheDocument();
  });
});
