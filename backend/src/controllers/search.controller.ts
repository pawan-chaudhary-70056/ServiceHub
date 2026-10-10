import type { Request, Response } from 'express';
import { downloadExport, getExport, requestExport, runReport, search } from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import { requestMeta } from './support';
import type { ReportQuery, SearchQuery } from '../validators/search.validators';

/**
 * Search, reports, and report exports (docs/30 §3/§5, docs/11 §9).
 *
 * All read-only projections or export jobs. Authorization is applied in the service, which
 * resolves the caller's scope; the route declares the coarse permission. An export is
 * self-scoped — only the requester may read or download it.
 */

/** `GET /search` — unified, permission-scoped search (docs/30 §2). */
export async function getSearch(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<unknown, unknown, SearchQuery>(res);
  const result = await search(req.actor, {
    query: query.q,
    ...(query.types ? { types: query.types } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
  });
  res.status(200).json(result);
}

/** `GET /reports/{metric}` — a scoped report over a period (docs/30 §3). */
export async function getReport(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params, query } = validated<unknown, { metric: string }, ReportQuery>(res);
  const report = await runReport(req.actor, params.metric, {
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  });
  res.status(200).json({ report });
}

/** `POST /reports/{metric}/export` — queues an async export (`docs/30` §5, R4). */
export async function postReportExport(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params, body } = validated<ReportQuery, { metric: string }>(res);
  const job = await requestExport(
    req.actor,
    params.metric,
    { ...(body.from ? { from: body.from } : {}), ...(body.to ? { to: body.to } : {}) },
    requestMeta(req),
  );
  res.status(202).json({ export: job });
}

/** `GET /reports/jobs/{id}` — an export's status and, on success, its download link. */
export async function getReportExport(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const job = await getExport(req.actor, params.id);
  res.status(200).json({ export: job });
}

/**
 * `GET /reports/jobs/{id}/download` — the CSV, while the link is live (`docs/30` §5).
 *
 * Two shapes, because the export lives in object storage (`ADR-0004`, `docs/19` §7.3): when the
 * driver can issue a signed URL the API **redirects** to it and no bytes pass through the
 * backend; otherwise (the local driver, development and tests) the API streams the file itself.
 * Authorization and expiry are checked before either, so the redirect cannot be used to fetch
 * an export the caller does not own.
 */
export async function getReportExportDownload(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const target = await downloadExport(req.actor, params.id);

  if (target.kind === 'redirect') {
    // The signed URL expires on its own; `Cache-Control` keeps a proxy from holding a copy
    // of a link that is about to become worthless.
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
