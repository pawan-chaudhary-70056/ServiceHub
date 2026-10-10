import { Router } from 'express';
import {
  deleteTeamMember,
  getTeamMembersForCaller,
  getTeams,
  postTeam,
  postTeamMember,
} from '../controllers/teams.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import {
  addTeamMemberSchema,
  createTeamSchema,
  teamMemberParamsSchema,
  teamParamsSchema,
} from '../validators/team.validators';

/**
 * Teams routes (docs/07 §6, docs/11 §9).
 *
 * Two permission levels, and the split is the point:
 *
 *   - **reading** the team list needs `catalog:read`, because any member must be able to
 *     see which teams exist to route a request (docs/21 §7);
 *   - **administering** teams — creating one, adding or removing a member — needs
 *     `user:manage` (docs/07 §3, the `User manage` row). Membership decides who can see
 *     and update records through team scope, so it is user administration, not catalog
 *     browsing (`docs/07` §6).
 *
 * The service re-checks tenancy on every path; the route guard is the fast rejection.
 */
export const teamsRouter = Router();

teamsRouter.use(authenticate);

teamsRouter.get('/', requirePermission('catalog:read'), getTeams);

teamsRouter.post(
  '/',
  requirePermission('user:manage'),
  csrfProtection,
  validate({ body: createTeamSchema }),
  postTeam,
);

teamsRouter.get(
  '/:id/members',
  requirePermission('user:manage'),
  validate({ params: teamParamsSchema }),
  getTeamMembersForCaller,
);

teamsRouter.post(
  '/:id/members',
  requirePermission('user:manage'),
  csrfProtection,
  validate({ params: teamParamsSchema, body: addTeamMemberSchema }),
  postTeamMember,
);

teamsRouter.delete(
  '/:id/members/:userId',
  requirePermission('user:manage'),
  csrfProtection,
  validate({ params: teamMemberParamsSchema }),
  deleteTeamMember,
);
