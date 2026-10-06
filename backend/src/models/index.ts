/**
 * Data access layer — the ONLY module that touches Prisma.
 *
 * ── Why this lives in `models/` ────────────────────────────────────────────────
 * docs/03-ARCHITECTURE.md names a repositories layer, but the charter's mandated
 * `backend/src/` structure has no `repositories/` directory and must not be changed
 * (§3, "structure rule"). The mandated `models/` folder is therefore the data-access
 * home: each entity's queries are exported from a module here, and only `services/`
 * may import them. The ESLint boundary rules in `eslint.config.mjs` enforce that
 * controllers never reach this layer directly (docs/38 §3).
 *
 * Query rules that apply to everything in this folder (docs/33 §7):
 *   - select the fields that are used; never `SELECT *` shaping in the application
 *   - paginate every collection (cursor-based for records — docs/11 §6)
 *   - every filter and sort column is indexed (docs/09)
 *   - no N+1: use explicit includes, never a loop of queries
 *   - no external I/O inside a transaction
 */

export {
  prisma,
  runInTransaction,
  pingDatabase,
  disconnectDatabase,
  isDatabaseConfigured,
  type DataClient,
  type TxClient,
} from './db';

export * from './organization.model';
export * from './user.model';
export * from './session.model';
export * from './invitation.model';
export * from './password-reset.model';
export * from './role.model';
export * from './audit.model';
export * from './outbox.model';
export * from './notification.model';
export * from './search.model';
export * from './report.model';
export * from './report-export.model';
export * from './catalog.model';
export * from './sla.model';
export * from './team.model';
export * from './request.model';
export * from './incident.model';
export * from './task.model';
export * from './approval.model';
export * from './comment.model';
export * from './reference.model';
