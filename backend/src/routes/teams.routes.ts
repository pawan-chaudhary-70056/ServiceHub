import { Router } from 'express';
import { getTeams } from '../controllers/teams.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';

/**
 * Teams routes (docs/07, docs/11 §9). Read-only for now; membership management arrives
 * with its own work. Every tenant member holds `catalog:read`, so any member can see the
 * teams they might route work to.
 */
export const teamsRouter = Router();

teamsRouter.use(authenticate);
teamsRouter.get('/', requirePermission('catalog:read'), getTeams);
