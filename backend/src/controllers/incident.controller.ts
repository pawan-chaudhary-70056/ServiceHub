import type { Request, Response } from 'express';
import {
  addIncidentComment,
  assignIncident,
  closeIncident,
  createIncidentFromReport,
  getIncident,
  getIncidentHistory,
  listIncidentComments,
  listIncidentsPage,
  reopenIncident,
  resolveIncident,
  setIncidentMajor,
  updateIncidentFields,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  AssignIncidentInput,
  CreateIncidentInput,
  IncidentCommentInput,
  IncidentStatusInput,
  MajorIncidentInput,
  ResolveIncidentInput,
  UpdateIncidentInput,
} from '../validators/incident.validators';
import { requestMeta } from './support';

/**
 * Incident endpoints (docs/23 §10, docs/11 §9).
 *
 * The route carries the coarse `incident:read.*` / `incident:create` permission; the
 * service applies the object-level scope (`own`/`team`/`any`), the derivation matrix and
 * the state machine. A caller who may not see a record receives 404, not 403 (docs/17).
 */

/** `GET /incidents` — cursor-paginated list under the caller's read scope. */
export async function getIncidents(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<
    unknown,
    unknown,
    { limit: number; cursor?: string; status?: IncidentStatusInput; majorOnly?: boolean }
  >(res);
  const page = await listIncidentsPage(query, req.actor);
  res.status(200).json(page);
}

/** `POST /incidents` — reports an incident (`201`). Any authenticated user may. */
export async function postIncident(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateIncidentInput>(res);
  const incident = await createIncidentFromReport(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/incidents/${incident.id}`);
  res.status(201).json({ incident });
}

/** `GET /incidents/{id}` — object-level read. */
export async function getIncidentById(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const incident = await getIncident(params.id, req.actor);
  res.status(200).json({ incident });
}

/** `PATCH /incidents/{id}` — field edits; priority override is permissioned. */
export async function patchIncident(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<UpdateIncidentInput, { id: string }>(res);
  const incident = await updateIncidentFields(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ incident });
}

/** `POST /incidents/{id}/assign` — assigns; a NEW incident starts on assignment. */
export async function postAssign(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<AssignIncidentInput, { id: string }>(res);
  const incident = await assignIncident(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ incident });
}

/** `POST /incidents/{id}/resolve` — requires a resolution summary. */
export async function postResolve(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<ResolveIncidentInput, { id: string }>(res);
  const incident = await resolveIncident(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ incident });
}

/** `POST /incidents/{id}/close` — RESOLVED → CLOSED. */
export async function postClose(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const incident = await closeIncident(params.id, req.actor, requestMeta(req));
  res.status(200).json({ incident });
}

/** `POST /incidents/{id}/reopen` — RESOLVED/CLOSED → IN_PROGRESS, with a new clock. */
export async function postReopen(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<{ reason?: string }, { id: string }>(res);
  const incident = await reopenIncident(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ incident });
}

/** `POST /incidents/{id}/major` — toggles the major flag; audited both ways. */
export async function postMajor(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<MajorIncidentInput, { id: string }>(res);
  const incident = await setIncidentMajor(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ incident });
}

/** `GET /incidents/{id}/comments` — visible conversation (internal notes filtered). */
export async function getComments(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params, query } = validated<unknown, { id: string }, { limit: number; cursor?: string }>(
    res,
  );
  const page = await listIncidentComments(params.id, query, req.actor);
  res.status(200).json(page);
}

/** `POST /incidents/{id}/comments` — adds a public or internal comment (`201`). */
export async function postComment(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<IncidentCommentInput, { id: string }>(res);
  const comment = await addIncidentComment(params.id, body, req.actor, requestMeta(req));
  res.status(201).json({ comment });
}

/** `GET /incidents/{id}/history` — audit projection (`docs/31` §8). */
export async function getHistory(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params, query } = validated<unknown, { id: string }, { limit: number }>(res);
  const history = await getIncidentHistory(params.id, query, req.actor);
  res.status(200).json({ history });
}
