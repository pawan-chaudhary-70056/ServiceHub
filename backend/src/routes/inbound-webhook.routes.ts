import { Router } from 'express';
import {
  getInboundDeadLetters,
  getInboundEndpoints,
  patchInboundEndpoint,
  postInboundEndpoint,
  postInboundWebhook,
  postRetryInboundDeadLetter,
} from '../controllers/inbound-webhook.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  createInboundEndpointSchema,
  inboundProviderParamsSchema,
  updateInboundEndpointSchema,
} from '../validators/inbound-webhook.validators';
import { deadLetterQuerySchema } from '../validators/webhook.validators';

/**
 * Inbound webhook routes (`docs/32` §5/§12).
 *
 * Split into two routers on purpose:
 *
 *   - `inboundAdminRouter` is mounted under `/admin` and manages receivers
 *     (`integration:read`/`integration:manage`/`integration:retry`), CSRF-protected.
 *   - `inboundPublicRouter` is mounted on the API root with **no `authenticate`**: a provider
 *     posts with no session. Its authentication is the HMAC signature over the raw body,
 *     enforced in the service, and it is CSRF-exempt because CSRF defends cookie sessions,
 *     which an external caller does not have.
 *
 * The public route stays behind the application rate limiter (it is mounted under
 * `API_PREFIX`), because an unauthenticated endpoint is exactly the one a flood targets
 * (`docs/33` §6).
 */

export const inboundAdminRouter = Router();

inboundAdminRouter.use(authenticate);

inboundAdminRouter.get(
  '/inbound-endpoints',
  requirePermission('integration:read'),
  getInboundEndpoints,
);
inboundAdminRouter.post(
  '/inbound-endpoints',
  requirePermission('integration:manage'),
  csrfProtection,
  validate({ body: createInboundEndpointSchema }),
  postInboundEndpoint,
);
inboundAdminRouter.patch(
  '/inbound-endpoints/:id',
  requirePermission('integration:manage'),
  csrfProtection,
  validate({ params: idParamsSchema, body: updateInboundEndpointSchema }),
  patchInboundEndpoint,
);

inboundAdminRouter.get(
  '/integrations/inbound-dead-letters',
  requirePermission('integration:read'),
  validate({ query: deadLetterQuerySchema }),
  getInboundDeadLetters,
);
inboundAdminRouter.post(
  '/integrations/inbound-dead-letters/:id/retry',
  requirePermission('integration:retry'),
  csrfProtection,
  validate({ params: idParamsSchema }),
  postRetryInboundDeadLetter,
);

/** Public receive surface. No session; the signature is the authentication (`docs/32` §5). */
export const inboundPublicRouter = Router();

inboundPublicRouter.post(
  '/webhooks/inbound/:provider',
  validate({ params: inboundProviderParamsSchema }),
  postInboundWebhook,
);
