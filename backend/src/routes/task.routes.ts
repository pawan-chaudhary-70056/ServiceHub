import { Router } from 'express';
import {
  getMyTasks,
  getTaskById,
  patchTask,
  postAssign,
  postTransition,
} from '../controllers/task.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  assignTaskSchema,
  listTasksQuerySchema,
  transitionTaskSchema,
  updateTaskSchema,
} from '../validators/task.validators';

/**
 * Standalone task routes (docs/24 §9).
 *
 * Nested creation and listing live on the parent routers (`/requests/{id}/tasks`,
 * `/incidents/{id}/tasks`) because they are reached through the parent. Everything that
 * addresses a task directly is here. Task reads inherit the parent's visibility, enforced
 * in the service (`docs/24` rule T2), so no read permission is declared at this layer.
 */
export const taskRouter = Router();

taskRouter.use(authenticate);

// "My tasks" is any caller who may work a task; the service narrows to their assignments.
taskRouter.get(
  '/',
  requireAnyPermission(['task:update.own', 'task:update.team', 'task:update.any']),
  validate({ query: listTasksQuerySchema }),
  getMyTasks,
);

taskRouter.get('/:id', validate({ params: idParamsSchema }), getTaskById);
taskRouter.patch(
  '/:id',
  csrfProtection,
  validate({ params: idParamsSchema, body: updateTaskSchema }),
  patchTask,
);
taskRouter.post(
  '/:id/assign',
  csrfProtection,
  validate({ params: idParamsSchema, body: assignTaskSchema }),
  postAssign,
);
taskRouter.post(
  '/:id/transition',
  csrfProtection,
  validate({ params: idParamsSchema, body: transitionTaskSchema }),
  postTransition,
);
