import { describe, expect, it } from 'vitest';
import {
  assertPermission,
  hasEveryPermission,
  hasPermission,
  type Principal,
} from '../src/helpers/authorization';
import { ForbiddenError } from '../src/utils/errors';

/**
 * Authorization stage 1 — the role/permission check (docs/07 §1).
 *
 * These tests lock down the two properties that make the primitive safe to compose:
 * a deactivated principal holds nothing regardless of its permission set, and a missing
 * principal is denied rather than treated as anonymous-but-allowed. Scope and object
 * checks (stages 2 and 3) are the service's responsibility and are tested with the
 * entities they protect.
 */
function actor(permissions: string[], isActive = true): Principal {
  // Stage 1 only: the tenant scope (`organizationId`) is inert here and exercised with
  // the services that apply it (docs/07 §6).
  return { userId: 'user_1', organizationId: null, isActive, permissions: new Set(permissions) };
}

describe('hasPermission', () => {
  it('is true only when the active caller holds the permission', () => {
    expect(hasPermission(actor(['request:create']), 'request:create')).toBe(true);
    expect(hasPermission(actor(['request:create']), 'request:update.any')).toBe(false);
  });

  it('denies a deactivated caller even when the permission set is present', () => {
    // Deactivation revokes effective access immediately (FR-USER-001, docs/06 §7).
    expect(hasPermission(actor(['request:read.any'], false), 'request:read.any')).toBe(false);
  });

  it('denies when there is no principal (public route)', () => {
    expect(hasPermission(undefined, 'request:create')).toBe(false);
  });
});

describe('assertPermission', () => {
  it('throws FORBIDDEN when the permission is absent', () => {
    expect(() => assertPermission(actor(['request:create']), 'user:manage')).toThrow(
      ForbiddenError,
    );
  });

  it('returns quietly when the permission is held', () => {
    expect(() => assertPermission(actor(['user:manage']), 'user:manage')).not.toThrow();
  });
});

describe('hasEveryPermission', () => {
  it('requires all permissions, not any', () => {
    const principal = actor(['request:read.any', 'request:assign']);
    expect(hasEveryPermission(principal, ['request:read.any', 'request:assign'])).toBe(true);
    expect(hasEveryPermission(principal, ['request:read.any', 'request:close.any'])).toBe(false);
  });
});
