import type { Request, Response } from 'express';
import {
  addComment,
  assignRequest,
  cancelRequest,
  createRequest,
  getRequest,
  listRequestComments,
  listRequestsPage,
  transitionRequest,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  AssignRequestInput,
  CommentInput,
  CreateRequestInput,
  RequestStatusInput,
  TransitionRequestInput,
} from '../validators/request.validators';
import { requestMeta } from './support';

/**
 * Service request endpoints (docs/22 §11, docs/11 §9).
 *
 * The route carries the coarse `request:read.own` / `request:create` permission; the
 * service applies the precise object-level scope (`own`/`team`/`any`) and the state
 * machine. A caller who may not see a record receives 404, not 403 (docs/17).
 */

/** `GET /requests` — cursor-paginated list under the caller's read scope. */
export async function getRequests(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<
    unknown,
    unknown,
    { limit: number; cursor?: string; status?: RequestStatusInput }
  >(res);
  const page = await listRequestsPage(query, req.actor);
  res.status(200).json(page);
}

/** `POST /requests` — raises a request from a catalog item (`201`). */
export async function postRequest(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateRequestInput>(res);
  const request = await createRequest(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/requests/${request.id}`);
  res.status(201).json({ request });
}

/** `GET /requests/{id}` — object-level read. */
export async function getRequestById(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const request = await getRequest(params.id, req.actor);
  res.status(200).json({ request });
}

/** `POST /requests/{id}/transition` — applies the state machine; `409` when illegal. */
export async function postTransition(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<TransitionRequestInput, { id: string }>(res);
  const request = await transitionRequest(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ request });
}

/** `POST /requests/{id}/assign` — assigns an assignee and/or team. */
export async function postAssign(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<AssignRequestInput, { id: string }>(res);
  const request = await assignRequest(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ request });
}

/** `POST /requests/{id}/cancel` — cancels own (or any, with the wider permission). */
export async function postCancel(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<{ reason?: string }, { id: string }>(res);
  const request = await cancelRequest(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ request });
}

/** `GET /requests/{id}/comments` — visible conversation (internal notes filtered out). */
export async function getComments(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params, query } = validated<unknown, { id: string }, { limit: number; cursor?: string }>(
    res,
  );
  const page = await listRequestComments(params.id, query, req.actor);
  res.status(200).json(page);
}

/** `POST /requests/{id}/comments` — adds a public or internal comment (`201`). */
export async function postComment(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<CommentInput, { id: string }>(res);
  const comment = await addComment(params.id, body, req.actor, requestMeta(req));
  res.status(201).json({ comment });
}
