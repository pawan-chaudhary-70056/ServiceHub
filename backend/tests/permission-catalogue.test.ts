import { describe, expect, it } from 'vitest';
import {
  allRoleDefinitions,
  PERMISSIONS,
  PLATFORM_ROLES,
  TENANT_ROLES,
} from '../src/helpers/permission-catalogue';

/**
 * The permission catalogue and role matrix (docs/07).
 *
 * The matrix is seeded data, and a typo in a permission key would silently grant nothing
 * (or, worse, be seeded as a dangling grant). These tests make the seed source
 * self-checking: every key a role references must exist, keys must be unique, and the
 * permission key format must hold.
 */
describe('permission catalogue', () => {
  it('has unique permission keys', () => {
    const keys = PERMISSIONS.map((permission) => permission.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses the resource:action[.qualifier] format', () => {
    for (const permission of PERMISSIONS) {
      // resource : action[:sub-action][.qualifier]  — e.g. request:read.own,
      // platform:organization:manage (docs/07 §1, extended with the platform scope).
      expect(permission.key).toMatch(/^[a-z]+(:[a-z]+)+(\.[a-z]+)?$/);
      expect(permission.key.startsWith(`${permission.resource}:`)).toBe(true);
    }
  });
});

describe('role matrix', () => {
  it('references only known permissions', () => {
    const known = new Set(PERMISSIONS.map((permission) => permission.key));
    const dangling = allRoleDefinitions().flatMap((role) =>
      role.permissions.filter((key) => !known.has(key)).map((key) => `${role.key} -> ${key}`),
    );
    expect(dangling).toEqual([]);
  });

  it('does not repeat a permission within a role', () => {
    for (const role of allRoleDefinitions()) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it('keeps platform and tenant roles disjoint by key', () => {
    const platform = new Set(PLATFORM_ROLES.map((role) => role.key));
    for (const role of TENANT_ROLES) {
      expect(platform.has(role.key)).toBe(false);
    }
  });

  it('grants a platform operator no tenant-scoped fulfilment permission', () => {
    // docs/07 §5: provisioning must not become tenant control.
    for (const role of PLATFORM_ROLES) {
      for (const key of role.permissions) {
        expect(key.startsWith('platform:') || key.startsWith('audit:')).toBe(true);
      }
    }
  });
});
