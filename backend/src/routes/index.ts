import { Router } from 'express';
import { adminApprovalRouter, approvalRouter } from './approval.routes';
import { authRouter } from './auth.routes';
import { catalogRouter } from './catalog.routes';
import { healthRouter } from './health.routes';
import { incidentRouter } from './incident.routes';
import { notificationRouter } from './notification.routes';
import { platformRouter } from './platform.routes';
import { requestRouter } from './request.routes';
import { rolesRouter } from './roles.routes';
import { searchRouter } from './search.routes';
import { slaRouter } from './sla.routes';
import { taskRouter } from './task.routes';
import { teamsRouter } from './teams.routes';
import { usersRouter } from './users.routes';

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
 * order (docs/40) as their owning documents reach `Approved`.
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
// Search and reporting (docs/30). Paths are `/search` and `/reports/{metric}`.
apiRouter.use('/', searchRouter);
// Notification centre and preferences (docs/29 §12): `/notifications` and
// `/me/notification-preferences`.
apiRouter.use('/', notificationRouter);

export default apiRouter;
