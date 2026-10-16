import { config } from '../config';
import { assertPermission, type Principal } from '../helpers/authorization';
import { isAntivirusConfigured } from '../integrations/antivirus';
import { emailAdapter } from '../integrations/email';
import { unsupportedEmailAdapter } from '../integrations';
import { directoryAdapter, unsupportedDirectoryAdapter } from '../integrations/directory';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  reliabilityConfigSchema,
  type IntegrationReliabilityConfig,
} from '../validators/integration-config.validators';
import {
  findIntegrationSetting,
  listIntegrationSettings,
  recordIntegrationTest,
  upsertIntegrationSetting,
  writeAudit,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Integration configuration administration (`docs/32` §7, §11, §12, §13).
 *
 * This is the surface the document names but the build had not yet delivered: `POST/PATCH
 * /admin/integrations/{id}` — "Configure; audited" — gated by `admin:config`.
 *
 * Three rules make it safe, and each is a real failure mode:
 *
 *   1. **The credential value never crosses this boundary.** Credentials are injected at
 *      runtime (`17` §3, `35`); the most a caller may set is a **reference** (`env:NAME`),
 *      which records where the secret comes from without storing it. A request that looks
 *      like it is trying to persist a secret is rejected, not trimmed.
 *   2. **Configuration is validated per key.** Only the keys the catalogue declares can be
 *      configured, and only the reliability knobs those keys accept. A free-form JSON blob
 *      would be a place for the next developer to hide a credential.
 *   3. **Every change is audited** with a before/after that omits the secret by construction
 *      (`31`, `32` §7).
 *
 * The catalogue is the single source of truth for "what integrations exist", so the UI
 * renders it rather than hard-coding a list that drifts from the backend.
 */

/**
 * The reliability knobs a tenant may tune, re-exported from the boundary schema so the
 * request validator and the service cannot drift apart (`docs/12`).
 */
export { reliabilityConfigSchema, type IntegrationReliabilityConfig };

/**
 * A credential reference, never a credential. The scheme names where the value lives; the
 * service never resolves it here, because this layer must not be able to read secrets.
 */
const CREDENTIAL_REF = /^(env|vault|secret|aws-secrets):[A-Za-z0-9_./#-]{1,190}$/;

export interface IntegrationCatalogueEntry {
  key: string;
  name: string;
  description: string;
  /** `outbound` / `inbound` / `both` — the direction this integration exchanges data. */
  direction: 'outbound' | 'inbound' | 'both';
  /** `true` when there is a single global endpoint whose reachability can be probed. */
  testable: boolean;
  /** `true` when the integration is backed by a runtime credential (so a ref is meaningful). */
  usesCredential: boolean;
  defaultConfig: Required<IntegrationReliabilityConfig>;
  credentialRefExample: string;
}

const DEFAULTS: Required<IntegrationReliabilityConfig> = {
  breakerFailureThreshold: 5,
  breakerOpenMs: 30_000,
  breakerHalfOpenSuccesses: 2,
  bulkheadMaxConcurrent: 10,
  bulkheadMaxQueue: 200,
  bulkheadQueueTimeoutMs: 5_000,
  retryMaxAttempts: 5,
  timeoutMs: 10_000,
};

/**
 * The integration catalogue (`docs/32` §2). Adding an integration is adding an entry here —
 * the API, the validation and the UI all read from it.
 */
export const INTEGRATION_CATALOGUE: readonly IntegrationCatalogueEntry[] = [
  {
    key: 'email',
    name: 'Email provider',
    description:
      'Outbound notifications and account email (docs/29). Delivery is retried and then dead-lettered; the provider is never on the request path.',
    direction: 'outbound',
    testable: true,
    usesCredential: true,
    defaultConfig: { ...DEFAULTS },
    credentialRefExample: 'env:SENDGRID_API_KEY',
  },
  {
    key: 'directory',
    name: 'Directory sync',
    description:
      'Inbound user-roster reconciliation (docs/32 §6). Identity is keyed on the source id; a missing person is deactivated, never deleted.',
    direction: 'inbound',
    testable: true,
    usesCredential: true,
    defaultConfig: { ...DEFAULTS, timeoutMs: 30_000 },
    credentialRefExample: 'env:DIRECTORY_API_TOKEN',
  },
  {
    key: 'webhooks',
    name: 'Outbound webhooks',
    description:
      'Signed event delivery to subscriber endpoints (docs/32 §4). Each subscription has its own secret; reachability is proved by delivery, not by a global probe.',
    direction: 'outbound',
    testable: false,
    usesCredential: false,
    defaultConfig: { ...DEFAULTS },
    credentialRefExample: 'env:UNUSED',
  },
  {
    key: 'antivirus',
    name: 'Antivirus scanning',
    description:
      'Asynchronous malware scan of uploaded files (docs/19 §7.2). A file is not retrievable until it clears the scan; with no scanner configured the upload is promoted on the request path and only the content sniff has run.',
    direction: 'outbound',
    testable: true,
    usesCredential: false,
    defaultConfig: { ...DEFAULTS, timeoutMs: 15_000 },
    credentialRefExample: 'env:UNUSED',
  },
  {
    key: 'inbound_webhooks',
    name: 'Inbound webhooks',
    description:
      'Signature-verified provider callbacks (docs/32 §5). Verify → persist → ack, processed by a worker; duplicate deliveries are idempotent.',
    direction: 'inbound',
    testable: false,
    usesCredential: false,
    defaultConfig: { ...DEFAULTS },
    credentialRefExample: 'env:UNUSED',
  },
];

function catalogueEntry(key: string): IntegrationCatalogueEntry {
  const entry = INTEGRATION_CATALOGUE.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new NotFoundError('Unknown integration.');
  }
  return entry;
}

export interface IntegrationConfigView {
  key: string;
  name: string;
  description: string;
  direction: IntegrationCatalogueEntry['direction'];
  testable: boolean;
  usesCredential: boolean;
  enabled: boolean;
  /** Effective configuration: defaults overlaid with any stored override. */
  config: Required<IntegrationReliabilityConfig>;
  /** The catalogue defaults, so the UI can show what a value was changed from. */
  defaults: Required<IntegrationReliabilityConfig>;
  credentialRef: string | null;
  /** Whether a runtime credential is actually present for this integration. */
  credentialConfigured: boolean;
  credentialRefExample: string;
  lastTestedAt: string | null;
  lastTestStatus: 'OK' | 'FAILED' | null;
  lastTestError: string | null;
  updatedAt: string | null;
}

function mergeConfig(stored: unknown): Required<IntegrationReliabilityConfig> {
  const parsed = reliabilityConfigSchema.safeParse(stored ?? {});
  const overrides = parsed.success ? parsed.data : {};
  return { ...DEFAULTS, ...overrides };
}

/** Whether the key has a working runtime adapter; the credential ref is only cosmetic if not. */
function credentialConfigured(key: string): boolean {
  if (key === 'email') return emailAdapter !== unsupportedEmailAdapter;
  if (key === 'directory') return directoryAdapter !== unsupportedDirectoryAdapter;
  // The scanner is configured by its URL, not by a credential: an unset `ANTIVIRUS_URL`
  // means the scan step is not in force, and the connectivity test should say so rather
  // than report a green light for a step that never runs.
  if (key === 'antivirus') return isAntivirusConfigured();
  return true;
}

function toView(
  entry: IntegrationCatalogueEntry,
  stored: Awaited<ReturnType<typeof findIntegrationSetting>>,
): IntegrationConfigView {
  return {
    key: entry.key,
    name: entry.name,
    description: entry.description,
    direction: entry.direction,
    testable: entry.testable,
    usesCredential: entry.usesCredential,
    enabled: stored?.enabled ?? true,
    config: mergeConfig(stored?.config),
    defaults: { ...entry.defaultConfig },
    credentialRef: stored?.credentialRef ?? null,
    credentialConfigured: credentialConfigured(entry.key),
    credentialRefExample: entry.credentialRefExample,
    lastTestedAt: stored?.lastTestedAt?.toISOString() ?? null,
    lastTestStatus: (stored?.lastTestStatus as 'OK' | 'FAILED' | null) ?? null,
    lastTestError: stored?.lastTestError ?? null,
    updatedAt: stored?.updatedAt?.toISOString() ?? null,
  };
}

/** `GET /admin/integrations/config` — the catalogue with effective settings. `integration:read`. */
export async function listIntegrationConfigForCaller(
  actor: Principal,
): Promise<IntegrationConfigView[]> {
  assertPermission(actor, 'integration:read');
  if (!actor.organizationId) {
    throw new NotFoundError('Integrations are tenant-scoped.');
  }
  const stored = await listIntegrationSettings(actor.organizationId);
  const byKey = new Map(stored.map((row) => [row.key, row]));
  return INTEGRATION_CATALOGUE.map((entry) => toView(entry, byKey.get(entry.key) ?? null));
}

export interface UpdateIntegrationConfigInput {
  enabled?: boolean;
  config?: IntegrationReliabilityConfig;
  /** A reference such as `env:SENDGRID_API_KEY`; never the secret. Pass `null` to clear. */
  credentialRef?: string | null;
}

/**
 * `PATCH /admin/integrations/config/{key}` — configures one integration (`admin:config`,
 * audited). A request carrying a literal secret is rejected by the reference pattern rather
 * than accepted as an opaque string.
 */
export async function updateIntegrationConfigForCaller(
  key: string,
  input: UpdateIntegrationConfigInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<IntegrationConfigView> {
  assertPermission(actor, 'admin:config');
  if (!actor.organizationId) {
    throw new NotFoundError('Integrations are tenant-scoped.');
  }
  const entry = catalogueEntry(key);
  const organizationId = actor.organizationId;

  // A credential reference must be a reference. `env:X` is accepted; `sk_live_…` is not, so a
  // caller cannot smuggle a value into a field whose whole purpose is to hold none.
  if (input.credentialRef !== undefined && input.credentialRef !== null) {
    if (!CREDENTIAL_REF.test(input.credentialRef)) {
      throw new ValidationError([
        {
          field: 'credentialRef',
          message:
            'A credential reference must name where the secret lives (for example env:SENDGRID_API_KEY), not the secret itself.',
        },
      ]);
    }
    if (!entry.usesCredential) {
      throw new ValidationError([
        {
          field: 'credentialRef',
          message: `${entry.name} uses per-record secrets, so it has no global credential to reference.`,
        },
      ]);
    }
  }

  const existing = await findIntegrationSetting(organizationId, key);
  const mergedConfig = mergeConfig(existing?.config);
  const nextConfig = { ...mergedConfig, ...(input.config ?? {}) };

  const saved = await upsertIntegrationSetting(organizationId, key, {
    enabled: input.enabled ?? existing?.enabled ?? true,
    config: nextConfig,
    credentialRef:
      input.credentialRef === undefined ? (existing?.credentialRef ?? null) : input.credentialRef,
    actorId: actor.userId,
  });

  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_CONFIG_UPDATE,
    entityType: AUDIT_ENTITY.INTEGRATION_SETTING,
    entityId: saved.id,
    before: existing
      ? {
          key,
          enabled: existing.enabled,
          config: mergeConfig(existing.config),
          // The reference is an audited fact; the credential it points at is not.
          credentialRef: existing.credentialRef,
        }
      : { key, configured: false },
    after: {
      key,
      enabled: saved.enabled,
      config: mergeConfig(saved.config),
      credentialRef: saved.credentialRef,
    },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });

  return toView(entry, saved);
}

export interface IntegrationTestResult {
  key: string;
  status: 'OK' | 'FAILED' | 'SKIPPED';
  message: string;
  checkedAt: string;
}

/**
 * `POST /admin/integrations/config/{key}/test` — a bounded connectivity check (`32` §13).
 *
 * For an integration with a single global endpoint this answers "is a credential present and
 * is the adapter wired", which is the only question answerable without sending real traffic.
 * For the webhook integrations there is no global endpoint — reachability is per subscription
 * and is proved by delivery — so the test reports `SKIPPED` rather than inventing a green
 * light. The result is recorded and audited either way.
 */
export async function testIntegrationForCaller(
  key: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<IntegrationTestResult> {
  assertPermission(actor, 'admin:config');
  if (!actor.organizationId) {
    throw new NotFoundError('Integrations are tenant-scoped.');
  }
  const entry = catalogueEntry(key);
  const organizationId = actor.organizationId;
  const checkedAt = new Date();

  let status: IntegrationTestResult['status'];
  let message: string;

  if (!entry.testable) {
    status = 'SKIPPED';
    message = `${entry.name} has no global endpoint; reachability is proved per ${entry.direction === 'outbound' ? 'subscription by delivery' : 'endpoint by receipt'}.`;
  } else if (credentialConfigured(key)) {
    status = 'OK';
    message = `${entry.name} is configured and a runtime adapter is present.`;
  } else {
    status = 'FAILED';
    message = `${entry.name} has no runtime adapter or credential configured in this environment.`;
  }

  const existing = await findIntegrationSetting(organizationId, key);
  if (existing && status !== 'SKIPPED') {
    await recordIntegrationTest(existing.id, {
      status,
      error: status === 'FAILED' ? message : null,
      at: checkedAt,
    });
  }

  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_CONFIG_TEST,
    entityType: AUDIT_ENTITY.INTEGRATION_SETTING,
    entityId: existing?.id ?? null,
    after: { key, status },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });

  return { key, status, message, checkedAt: checkedAt.toISOString() };
}

/** Exposed so a metric/doc can name the environment's configured breaker defaults. */
export const integrationReliabilityDefaults = {
  breakerFailureThreshold: config.INTEGRATION_BREAKER_FAILURE_THRESHOLD,
  breakerOpenMs: config.INTEGRATION_BREAKER_OPEN_MS,
  bulkheadMaxConcurrent: config.INTEGRATION_BULKHEAD_MAX_CONCURRENT,
} as const;
