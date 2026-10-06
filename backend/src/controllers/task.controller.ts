import type { Request, Response } from 'express';
import {
  assignTask,
  createTaskOnParent,
  getTask,
  listMyTasksPage,
  listParentTasks,
  transitionTask,
  updateTaskFields,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  AssignTaskInput,
  CreateTaskInput,
  TaskStatusInput,
  TransitionTaskInput,
  UpdateTaskInput,
} from '../validators/task.validators';
import { requestMeta } from './support';

/**
 * Task endpoints (docs/24 §9, docs/11 §9).
 *
 * Nested creation (`POST /requests/{id}/tasks`) resolves the parent through the parent's
 * own visibility rules, so a caller who cannot see the parent receives 404 rather than a
 * task they should not have (`docs/24` rule T2).
 */

/** `POST /requests/{id}/tasks` — nested creation on a request. */
export async function postRequestTask(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<CreateTaskInput, { id: string }>(res);
  const task = await createTaskOnParent('REQUEST', params.id, body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/tasks/${task.id}`);
  res.status(201).json({ task });
}

/** `POST /incidents/{id}/tasks` — nested creation on an incident. */
export async function postIncidentTask(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<CreateTaskInput, { id: string }>(res);
  const task = await createTaskOnParent('INCIDENT', params.id, body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/tasks/${task.id}`);
  res.status(201).json({ task });
}

/** `GET /requests/{id}/tasks` — a request's children. */
export async function getRequestTasks(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const items = await listParentTasks('REQUEST', params.id, req.actor);
  res.status(200).json({ items });
}

/** `GET /incidents/{id}/tasks` — an incident's children. */
export async function getIncidentTasks(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const items = await listParentTasks('INCIDENT', params.id, req.actor);
  res.status(200).json({ items });
}

/** `GET /tasks` — the caller's assigned tasks, cursor-paginated. */
export async function getMyTasks(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<
    unknown,
    unknown,
    { limit: number; cursor?: string; status?: TaskStatusInput }
  >(res);
  const page = await listMyTasksPage(query, req.actor);
  res.status(200).json(page);
}

/** `GET /tasks/{id}` — inherits the parent's visibility. */
export async function getTaskById(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const task = await getTask(params.id, req.actor);
  res.status(200).json({ task });
}

/** `PATCH /tasks/{id}` — title, description, due date, assignee. */
export async function patchTask(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<UpdateTaskInput, { id: string }>(res);
  const task = await updateTaskFields(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ task });
}

/** `POST /tasks/{id}/assign` — assigns or reassigns (audited, rule T5). */
export async function postAssign(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<AssignTaskInput, { id: string }>(res);
  const task = await assignTask(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ task });
}

/** `POST /tasks/{id}/transition` — applies the state machine (`409` when illegal). */
export async function postTransition(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<TransitionTaskInput, { id: string }>(res);
  const task = await transitionTask(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ task });
}
