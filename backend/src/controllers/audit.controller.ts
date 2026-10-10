import type { Request, Response } from 'express';
import {
  downloadAuditExport,
  getAuditExport,
  getRecordHistoryForCaller,
  listAuditEntries,
  listSecurityAuditEntries,
  requestAuditExport,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type { AuditExportBody, AuditListQuery } from '../validators/audit.validators';
import { requestMeta } from './support';

/**
 * Audit explorer endpoints (docs/31 §10, docs/11 §9).
 *
 * The route carries the coarse `audit:read.team`/`audit:read.all` permission; the service
 * applies the scope as a **query predicate** and records the access itself (`docs/31` §5).
 * A security-class entry is withheld from a caller without `audit:read.security` rather
 * than returned with a flag.
 */

/** `GET /audit` — the scoped, filterable log (`docs/31` §10). */
export async function getAudit(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { query } = validated<unknown, unknown, AuditListQuery>(res);
  res.status(200).json(await listAuditEntries(query, req.actor, requestMeta(req)));
}

/** `GET /audit/security` — the security class only (`docs/31` §10). */
export async function getSecurityAudit(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { query } = validated<unknown, unknown, { limit: number; cursor?: string }>(res);
  res.status(200).json(await listSecurityAuditEntries(query, req.actor, requestMeta(req)));
}

/**
 * `GET /audit/records/{entityType}/{entityId}` — a record's history without the security
 * class (`docs/31` §10).
 *
 * The caller must either hold an audit read grant **or** be entitled to read the record
 * itself — the record half of `docs/31` §5. The entitlement is resolved by the owning
 * service's own object-level check, so this projection can never become a back door to a
 * record the caller may not see.
 */
export async function getRecordAudit(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params, query } = validated<
    unknown,
    { entityType: string; entityId: string },
    { limit: number }
  >(res);
  const history = await getRecordHistoryForCaller(
    {
      entityType: params.entityType,
      entityId: params.entityId,
      limit: query.limit,
    },
    req.actor,
  );
  res.status(200).json({ history });
}

/**
 * `POST /audit/export` — queues an async audit export (`docs/31` §9/§10, `docs/30` §5).
 *
 * Returns `202` with the job, never the rows: an exhaustive audit query must not block a
 * request thread, and the export is itself audited with its filters (§6).
 */
export async function postAuditExport(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<AuditExportBody>(res);
  const job = await requestAuditExport(body, req.actor, requestMeta(req));
  res.status(202).json({ export: job });
}

/** `GET /audit/exports/{id}` — the caller's export status (`docs/31` §10, `docs/30` §5). */
export async function getAuditExportStatus(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  const job = await getAuditExport(req.actor, params.id);
  res.status(200).json({ export: job });
}

/**
 * `GET /audit/exports/{id}/download` — the CSV, while the link is live (`docs/30` §5).
 *
 * Redirects to a signed object-storage URL when the driver issues one, and streams from the
 * local driver otherwise — the same two shapes the report download uses (`ADR-0004`).
 */
export async function getAuditExportDownload(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  const target = await downloadAuditExport(req.actor, params.id);

  if (target.kind === 'redirect') {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, target.url);
    return;
  }

  res.setHeader('Content-Type', target.contentType);
  res.setHeader('Content-Disposition', target.disposition);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200);
  target.stream.pipe(res);
}
