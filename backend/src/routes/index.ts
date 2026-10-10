import { Router } from 'express';
import { adminApprovalRouter, approvalRouter } from './approval.routes';
import { attachmentRouter } from './attachment.routes';
import { auditRouter } from './audit.routes';
import { authRouter } from './auth.routes';
import { catalogRouter } from './catalog.routes';
import { healthRouter } from './health.routes';
import { assetRouter, assetTypeRouter } from './asset.routes';
import { incidentRouter } from './incident.routes';
import { kbRouter } from './kb.routes';
import { notificationRouter } from './notification.routes';
import { platformRouter } from './platform.routes';
import { requestRouter } from './request.routes';
import { rolesRouter } from './roles.routes';
import { searchRouter } from './search.routes';
import { slaRouter } from './sla.routes';
import { taskRouter } from './task.routes';
import { teamsRouter } from './teams.routes';
import { usersRouter } from './users.routes';
import { webhookRouter } from './webhook.routes';
import { inboundAdminRouter, inboundPublicRouter } from './inbound-webhook.routes';

/**
 * Route composition root (docs/03 §3, docs/11).
 *
 * Routes map a path to a controller and declare the permissions required for it. They
 * contain no logic beyond that mapping, and every route must state its permission so
 * authorization is visible at the surface rather than discovered in a service.
 *
 * Note the two-router split:
 *
 *   - `probeRouter` is mounted WITHOUT rate limiting, because a rate-limited health
 *     probe reports a false outage.
 *   - `apiRouter` carries the domain surface and sits behind the application rate
 *     limiter and the authentication middleware (`ADR-0001`).
 *
 * Domain routers (catalog, requests, incidents, tasks, SLA, approvals, knowledge,
 * assets, notifications, search, reports, audit) are added to `apiRouter` in phase-2
 * order (docs/40) as their owning documents reach `Approved`. Knowledge (`27`) and
 * assets (`28`) are mounted here having reached `Approved` on 2026-10-07.
 */

/** Health and readiness probes. Never rate limited. */
export const probeRouter: Router = healthRouter;

/** The authenticated, rate-limited domain API surface. */
export const apiRouter: Router = Router();

// Identity and platform administration (phase 2). Domain routers (catalog, requests,
// incidents, …) are mounted here in phase-2 order (docs/40) as their owning documents
// reach `Approved`.
apiRouter.use('/auth', authRouter);
apiRouter.use('/platform', platformRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/roles', rolesRouter);
apiRouter.use('/catalog', catalogRouter);
apiRouter.use('/sla', slaRouter);
apiRouter.use('/teams', teamsRouter);
apiRouter.use('/requests', requestRouter);
apiRouter.use('/incidents', incidentRouter);
apiRouter.use('/tasks', taskRouter);
apiRouter.use('/approvals', approvalRouter);
apiRouter.use('/admin', adminApprovalRouter);
// Knowledge base (docs/27 §8). Paths are `/kb/articles`, `/kb/categories`, `/kb/stats`.
apiRouter.use('/kb', kbRouter);
// Asset register (docs/28 §8): `/assets` and the admin type builder at
// `/admin/asset-types` (composed with the approval-template router under `/admin`).
apiRouter.use('/assets', assetRouter);
apiRouter.use('/admin', assetTypeRouter);
// Integrations (docs/32 §12, Approved 2026-10-08): the webhook admin at `/admin/webhooks`
// and the dead-letter viewer/retry at `/admin/integrations/dead-letters`.
apiRouter.use('/admin', webhookRouter);
apiRouter.use('/admin', inboundAdminRouter);
// The public inbound receive surface (`docs/32` §5): `/webhooks/inbound/{provider}`. No
// session — the HMAC signature over the raw body is the authentication, enforced in the
// service. Still behind the application rate limiter, because an unauthenticated endpoint is
// what a flood targets (`docs/33` §6).
apiRouter.use('/', inboundPublicRouter);
// File attachments (docs/19 §7, F-16): `/attachments` — list, multipart upload and
// the authorized download. No route-level permission: access always follows the parent
// (`07` §4), resolved inside the service.
apiRouter.use('/attachments', attachmentRouter);
// Search and reporting (docs/30). Paths are `/search` and `/reports/{metric}`.
apiRouter.use('/', searchRouter);
// Audit explorer (docs/31 §10): `/audit`, `/audit/security` and
// `/audit/records/{entityType}/{entityId}`. Read-only by construction — no mutation route
// exists on this surface (docs/31 §9).
apiRouter.use('/audit', auditRouter);
// Notification centre and preferences (docs/29 §12): `/notifications` and
// `/me/notification-preferences`.
apiRouter.use('/', notificationRouter);

export default apiRouter;
