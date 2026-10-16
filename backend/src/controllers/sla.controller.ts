import type { Request, Response } from 'express';
import {
  createCalendar,
  createPolicy,
  getClock,
  getPolicy,
  listCalendars,
  listPolicies,
  overrideClock,
  updateCalendar,
  updatePolicy,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  CreateBusinessCalendarInput,
  CreateSlaPolicyInput,
  OverrideSlaClockInput,
  UpdateBusinessCalendarInput,
} from '../validators/sla.validators';
import { requestMeta } from './support';

/**
 * SLA configuration endpoints (docs/25 §11, docs/11 §9).
 *
 * All routes require `sla:policy:manage` (administrator). SLA semantics are owned by
 * docs/25; clock mechanics live with the records that carry clocks, not here.
 */

/** `GET /sla/calendars` — the tenant's business calendars. */
export async function getCalendars(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listCalendars(req.actor);
  res.status(200).json({ items });
}

/** `POST /sla/calendars` — creates a business calendar (`201`). */
export async function postCalendar(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateBusinessCalendarInput>(res);
  const calendar = await createCalendar(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/sla/calendars/${calendar.id}`);
  res.status(201).json({ calendar });
}

/**
 * `PATCH /sla/calendars/{id}` — edits a calendar by creating the next version (`200`).
 *
 * The response is the **new** version: its id is what the client should address from now
 * on, and the Location header says so. The old id keeps resolving (GET is not version
 * aware) but is superseded — no longer the version policies point at.
 */
export async function patchCalendar(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<UpdateBusinessCalendarInput, { id: string }>(res);
  const calendar = await updateCalendar(params.id, body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/sla/calendars/${calendar.id}`);
  res.status(200).json({ calendar });
}

/** `GET /sla/policies` — policies with their target matrix and calendar. */
export async function getPolicies(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const items = await listPolicies(req.actor);
  res.status(200).json({ items });
}

/** `GET /sla/policies/{id}` — one policy. */
export async function getPolicyById(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const policy = await getPolicy(params.id, req.actor);
  res.status(200).json({ policy });
}

/** `POST /sla/policies` — creates a policy and its target matrix (`201`). */
export async function postPolicy(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateSlaPolicyInput>(res);
  const policy = await createPolicy(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/sla/policies/${policy.id}`);
  res.status(201).json({ policy });
}

/** `PATCH /sla/policies/{id}` — edits a policy; in-flight clocks keep their targets. */
export async function patchPolicy(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<
    {
      name?: string;
      calendarId?: string;
      pauseStates?: string[];
      isActive?: boolean;
      isDefault?: boolean;
      targets?: CreateSlaPolicyInput['targets'];
    },
    { id: string }
  >(res);
  const policy = await updatePolicy(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ policy });
}

/**
 * `GET /sla/clocks/{id}` — the clock on a record the caller may see (`docs/25` §11).
 *
 * No `sla:policy:manage` here on purpose: a requester looking at their own request must be
 * able to see its SLA state (§12 puts the indicator in every detail header). The scope and
 * object-level rule are enforced by the service, against the record the clock belongs to.
 */
export async function getClockById(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const clock = await getClock(params.id, req.actor);
  res.status(200).json({ clock });
}

/** `POST /sla/clocks/{id}/override` — moves a target or clears a breach, with a reason. */
export async function postClockOverride(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<OverrideSlaClockInput, { id: string }>(res);
  const clock = await overrideClock(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ clock });
}
