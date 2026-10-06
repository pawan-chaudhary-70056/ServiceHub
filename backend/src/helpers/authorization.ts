import { ForbiddenError } from '../utils/errors';

/**
 * Authorization primitives (docs/07).
 *
 * Authorization has three stages, always in this order:
 *
 *   1. ROLE      does the caller hold the required permission at all?
 *   2. SCOPE     is the object inside the caller's scope (tenant/org/team)?
 *   3. OBJECT    is the caller entitled to *this* object (owner, assignee, approver…)?
 *
 * This module implements **stage 1 only**. It is necessary and insufficient: a role
 * check without a scope and object check is the dominant real-world failure in tools
 * like this (IDOR). Services must follow a permission check with a query that applies
 * the tenant predicate and the object-level rule in `models/` (docs/07 §6, docs/17).
 *
 * Permissions are **data, not literals**: a service asks whether the caller holds
 * `request:update.assigned`, never inspects a role name (docs/07 §1).
 */

/** The authenticated caller, as resolved per request (`ADR-0001`). */
export interface Principal {
  userId: string;
  /**
   * The tenant the caller belongs to; null for a platform operator (`ADR-0012`).
   *
   * Scope stage (stage 2 of docs/07 §1) starts here: a service uses this to apply the
   * mandatory tenant predicate in the query, never as a post-fetch filter. A platform
   * operator has no organization and therefore no tenant scope.
   */
  organizationId: string | null;
  /** A deactivated user holds no effective permission, even if a session lingers. */
  isActive: boolean;
  permissions: ReadonlySet<string>;
}

export function hasPermission(actor: Principal | undefined, permission: string): boolean {
  return Boolean(actor?.isActive && actor.permissions.has(permission));
}

/** True when the caller holds **all** the named permissions. */
export function hasEveryPermission(
  actor: Principal | undefined,
  permissions: readonly string[],
): boolean {
  return permissions.every((permission) => hasPermission(actor, permission));
}

/**
 * Throws `FORBIDDEN` (403) unless the caller holds the permission.
 *
 * Use this for a capability the caller may never perform. When the caller may not even
 * *see* the target object, throw `NotFoundError` (404) instead, so the API does not
 * disclose that the record exists (docs/07 §1, docs/17).
 */
export function assertPermission(actor: Principal | undefined, permission: string): void {
  if (!hasPermission(actor, permission)) {
    throw new ForbiddenError();
  }
}

/** True when the caller holds **any** of the named permissions. */
export function hasAnyPermission(
  actor: Principal | undefined,
  permissions: readonly string[],
): boolean {
  return permissions.some((permission) => hasPermission(actor, permission));
}

/**
 * Throws `FORBIDDEN` unless the caller holds at least one of the permissions.
 *
 * Used where a capability is expressed as a set of scoped grants rather than one key:
 * reading requests is `request:read.own` **or** `.team` **or** `.any` depending on the
 * caller's role, so requiring a single key would wrongly exclude an agent (`07` §3).
 */
export function assertAnyPermission(
  actor: Principal | undefined,
  permissions: readonly string[],
): void {
  if (!hasAnyPermission(actor, permissions)) {
    throw new ForbiddenError();
  }
}

/** The read permissions for requests, in scope order (docs/07 §3). */
export const REQUEST_READ_PERMISSIONS = [
  'request:read.own',
  'request:read.team',
  'request:read.any',
] as const;

/** The read permissions for incidents, in scope order (docs/07 §3, docs/23 §9). */
export const INCIDENT_READ_PERMISSIONS = [
  'incident:read.own',
  'incident:read.team',
  'incident:read.any',
] as const;
