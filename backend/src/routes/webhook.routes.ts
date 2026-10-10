import { Router } from 'express';
import {
  getDeadLetters,
  getIntegrationHealthBoard,
  getWebhookEvents,
  getWebhooks,
  patchWebhook,
  postRetryDeadLetter,
  postWebhook,
} from '../controllers/webhook.controller';
import {
  getIntegrationConfig,
  patchIntegrationConfig,
  postIntegrationConfigTest,
} from '../controllers/integration-config.controller';
import { getRosterSyncStatus, postRosterSync } from '../controllers/roster-sync.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  createWebhookSubscriptionSchema,
  deadLetterQuerySchema,
  updateWebhookSubscriptionSchema,
  webhookSubscriptionParamsSchema,
} from '../validators/webhook.validators';
import { rosterSyncSchema } from '../validators/roster-sync.validators';
import {
  integrationKeyParamsSchema,
  updateIntegrationConfigSchema,
} from '../validators/integration-config.validators';

/**
 * Integration administration routes (docs/32 §12, docs/11 §9).
 *
 * Mounted at `/admin` alongside the approval-template and asset-type routers. Reading
 * subscription status is `integration:read`; changing a subscription is
 * `integration:manage`; retrying a dead-lettered delivery is its own grant,
 * `integration:retry`, because a retry can re-send data (`docs/32` §11).
 *
 * Mutations are CSRF-protected like every other state-changing surface.
 */
export const webhookRouter = Router();

webhookRouter.use(authenticate);

webhookRouter.get('/webhooks', requirePermission('integration:read'), getWebhooks);
// Declared before `PATCH /webhooks/:id` and distinct from it; it exposes the event vocabulary
// the subscription form selects from, so the UI never hard-codes event names.
webhookRouter.get('/webhooks/events', requirePermission('integration:read'), getWebhookEvents);
webhookRouter.post(
  '/webhooks',
  requirePermission('integration:manage'),
  csrfProtection,
  validate({ body: createWebhookSubscriptionSchema }),
  postWebhook,
);
webhookRouter.patch(
  '/webhooks/:id',
  requirePermission('integration:manage'),
  csrfProtection,
  validate({ params: webhookSubscriptionParamsSchema, body: updateWebhookSubscriptionSchema }),
  patchWebhook,
);

// The health board (`docs/32` §12/§13): last success, last error and dead-letter counts per
// integration, both directions. Declared before the dead-letter routes it is a sibling of.
webhookRouter.get(
  '/integrations',
  requirePermission('integration:read'),
  getIntegrationHealthBoard,
);

// Integration configuration administration (`docs/32` §11/§12/§13): the catalogue with this
// tenant's settings, and the audited `admin:config` write and connectivity test. Declared
// before any `/integrations/{id}`-shaped route so the literal segment wins.
webhookRouter.get(
  '/integrations/config',
  requirePermission('integration:read'),
  getIntegrationConfig,
);
webhookRouter.patch(
  '/integrations/config/:key',
  requirePermission('admin:config'),
  csrfProtection,
  validate({ params: integrationKeyParamsSchema, body: updateIntegrationConfigSchema }),
  patchIntegrationConfig,
);
webhookRouter.post(
  '/integrations/config/:key/test',
  requirePermission('admin:config'),
  csrfProtection,
  validate({ params: integrationKeyParamsSchema }),
  postIntegrationConfigTest,
);

// Roster sync (`docs/32` §6/§12): reconcile the user base against a directory. Status is a
// read; running one is an audited operator action, and the service's drift guard refuses a
// large removal unless the caller confirms it.
webhookRouter.get(
  '/integrations/roster-sync',
  requirePermission('integration:read'),
  getRosterSyncStatus,
);
webhookRouter.post(
  '/integrations/roster-sync',
  requirePermission('integration:manage'),
  csrfProtection,
  validate({ body: rosterSyncSchema }),
  postRosterSync,
);

webhookRouter.get(
  '/integrations/dead-letters',
  requirePermission('integration:read'),
  validate({ query: deadLetterQuerySchema }),
  getDeadLetters,
);
webhookRouter.post(
  '/integrations/dead-letters/:id/retry',
  requirePermission('integration:retry'),
  csrfProtection,
  validate({ params: idParamsSchema }),
  postRetryDeadLetter,
);
