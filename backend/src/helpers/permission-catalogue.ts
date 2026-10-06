/**
 * The permission catalogue and role→permission matrix (docs/07 §1–§3).
 *
 * This module is the **seed source**, not the runtime authority. Permissions and roles
 * are *data* (`docs/07` §1: "permissions are data, not literals"): the seed and tenant
 * provisioning write these into the database, and a service checks the caller's granted
 * permission set at runtime. `07` §3 says the matrix is seeded so an organisation can
 * adjust it without a deployment — this file is what gets seeded.
 *
 * Permission keys are a stable public contract: `resource:action[.qualifier]`. They may
 * be added, never renamed (`docs/11` §4).
 */

export interface PermissionDef {
  key: string;
  resource: string;
  action: string;
  description: string;
}

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  permissions: readonly string[];
}

const P = (key: string, description: string): PermissionDef => {
  const [head] = key.split(':');
  const rest = key.slice(key.indexOf(':') + 1);
  return { key, resource: head ?? key, action: rest, description };
};

/** The permission vocabulary (docs/07 §1, extended with the platform scope per ADR-0012). */
export const PERMISSIONS: readonly PermissionDef[] = [
  P('catalog:read', 'Browse the service catalog'),
  P('catalog:manage', 'Create and edit catalog categories and items'),

  P('request:create', 'Raise a service request'),
  P('request:read.own', 'Read own requests'),
  P('request:read.team', 'Read requests owned by the caller’s team'),
  P('request:read.any', 'Read any request in the tenant'),
  P('request:update.assigned', 'Update requests assigned to the caller'),
  P('request:update.any', 'Update any request in the tenant'),
  P('request:assign', 'Assign or reassign a request'),
  P('request:cancel.own', 'Cancel own request'),
  P('request:close.any', 'Close any request in the tenant'),

  P('incident:create', 'Report an incident'),
  P('incident:read.own', 'Read own reported incidents'),
  P('incident:read.team', 'Read incidents owned by the caller’s team'),
  P('incident:read.any', 'Read any incident in the tenant'),
  P('incident:update.any', 'Update any incident in the tenant'),
  // Distinct from `incident:update.any` by design (docs/23 §3, §9): overriding the
  // derived priority is a governance action, not routine triage, and it raises a
  // monitoring signal so a pattern of overrides is visible.
  P('incident:priority:override', 'Override an incident’s derived priority with a reason'),

  P('task:create', 'Create a task on a visible parent'),
  P('task:update.own', 'Update a task assigned to the caller'),
  P('task:update.team', 'Update a task within the caller’s team scope'),
  P('task:update.any', 'Update any task in the tenant'),
  P('task:cancel', 'Cancel a task with a reason'),
  P('task:override', 'Close a parent with open child tasks'),

  P('approval:decide', 'Decide an approval step the caller is designated for'),
  P('approval:read.pending', 'Read pending approvals in scope'),
  P('approval:reassign', 'Reassign an approval step to other approvers'),

  P('sla:policy:manage', 'Manage SLA policies, targets and calendars'),
  P('sla:clock:override', 'Override an SLA clock with a recorded reason'),

  P('kb:article:read', 'Read knowledge articles'),
  P('kb:article:author', 'Author knowledge articles'),
  P('kb:article:publish', 'Publish knowledge articles'),

  P('asset:read.own', 'Read assets the caller is custodian of'),
  P('asset:read.any', 'Read any asset in the tenant'),
  P('asset:manage', 'Manage the asset register'),
  P('asset:assign', 'Assign assets'),

  P('audit:read.team', 'Read audit records for the caller’s team'),
  P('audit:read.all', 'Read all audit records in the tenant'),
  P('audit:read.security', 'Read security-class audit records'),

  P('report:read', 'Read reports and dashboards'),
  P('report:read.all', 'Read cross-team reports (lead/admin)'),
  P('report:export', 'Export report and record data'),

  P('user:manage', 'Create, edit and deactivate users'),
  P('user:role:manage', 'Grant and revoke roles'),
  P('admin:config', 'Administrative configuration'),

  // Platform scope (ADR-0012). Held only by a platform operator; not tenant-scoped.
  P('platform:organization:manage', 'Provision and suspend tenants'),
  P('platform:operator:manage', 'Create and manage platform operators'),
  P('platform:audit:read', 'Read platform-scope audit'),
];

export const PLATFORM_ROLE_KEY = 'SUPER_ADMIN';

/** Platform-scoped roles (organizationId null). Seeded globally. */
export const PLATFORM_ROLES: readonly RoleDef[] = [
  {
    key: PLATFORM_ROLE_KEY,
    name: 'Super Admin',
    description:
      'Platform operator: provisions tenants and manages platform operators. Member of no organization; no tenant record access (ADR-0012, docs/07 §5).',
    permissions: [
      'platform:organization:manage',
      'platform:operator:manage',
      'platform:audit:read',
      'audit:read.security',
    ],
  },
];

/**
 * Tenant roles. Seeded **per organization** at provisioning (docs/04 §13.2), so each
 * tenant can adjust its own role→permission grants without affecting others.
 * Mapping mirrors the matrix in docs/07 §3.
 */
export const TENANT_ROLES: readonly RoleDef[] = [
  {
    key: 'REQUESTER',
    name: 'Requester',
    description: 'Raises and tracks own work.',
    permissions: [
      'catalog:read',
      'request:create',
      'request:read.own',
      'request:cancel.own',
      'incident:create',
      'incident:read.own',
      'task:update.own',
      'report:read',
      'kb:article:read',
    ],
  },
  {
    key: 'AGENT',
    name: 'Agent',
    description: 'Works assigned items across a team.',
    permissions: [
      'catalog:read',
      'request:create',
      'request:read.team',
      'request:update.assigned',
      'request:assign',
      'incident:create',
      'incident:read.team',
      'incident:update.any',
      'incident:priority:override',
      'task:create',
      'task:update.team',
      'task:update.any',
      'kb:article:read',
      'report:read',
      'asset:read.any',
    ],
  },
  {
    key: 'TEAM_LEAD',
    name: 'Team Lead',
    description: 'Owns queue health and SLA compliance for a team.',
    permissions: [
      'catalog:read',
      'request:create',
      'request:read.team',
      'request:read.any',
      'request:update.assigned',
      'request:update.any',
      'request:assign',
      'request:close.any',
      'incident:create',
      'incident:read.team',
      'incident:read.any',
      'incident:update.any',
      'incident:priority:override',
      'task:create',
      'task:update.team',
      'task:update.any',
      'task:cancel',
      'task:override',
      'approval:read.pending',
      'approval:reassign',
      'sla:clock:override',
      'kb:article:read',
      'report:read',
      'report:read.all',
      'report:export',
      'asset:read.any',
      'audit:read.team',
    ],
  },
  {
    key: 'APPROVER',
    name: 'Approver',
    description: 'Decides approvals only; no fulfilment permissions.',
    permissions: [
      'catalog:read',
      'incident:create',
      'kb:article:read',
      'approval:decide',
      'approval:read.pending',
    ],
  },
  {
    key: 'KB_CONTRIBUTOR',
    name: 'Knowledge Contributor',
    description: 'Authors and publishes knowledge articles.',
    permissions: [
      'catalog:read',
      'incident:create',
      'kb:article:read',
      'kb:article:author',
      'kb:article:publish',
    ],
  },
  {
    key: 'ASSET_MANAGER',
    name: 'Asset Manager',
    description: 'Owns the asset register and lifecycle.',
    permissions: [
      'catalog:read',
      'request:create',
      'incident:create',
      'asset:read.any',
      'asset:manage',
      'asset:assign',
      'report:read',
      'kb:article:read',
    ],
  },
  {
    key: 'ADMINISTRATOR',
    name: 'Administrator',
    description: 'Configures the system. Cannot approve requests (docs/07 §5).',
    permissions: [
      'catalog:read',
      'catalog:manage',
      'request:create',
      'request:read.any',
      'request:update.any',
      'request:assign',
      'request:close.any',
      'incident:create',
      'incident:read.any',
      'incident:update.any',
      'incident:priority:override',
      'task:create',
      'task:update.any',
      'task:cancel',
      'task:override',
      'approval:read.pending',
      'approval:reassign',
      'sla:policy:manage',
      'sla:clock:override',
      'kb:article:read',
      'kb:article:author',
      'kb:article:publish',
      'asset:read.any',
      'asset:manage',
      'asset:assign',
      'audit:read.all',
      'report:read',
      'report:read.all',
      'report:export',
      'user:manage',
      'user:role:manage',
      'admin:config',
    ],
  },
  {
    key: 'AUDITOR',
    name: 'Auditor',
    description: 'Read-only over audit and records. No mutation permission of any kind.',
    permissions: [
      'catalog:read',
      'request:read.any',
      'incident:read.any',
      'asset:read.any',
      'audit:read.all',
      'report:read',
      'kb:article:read',
    ],
  },
  {
    key: 'INTEGRATION',
    name: 'Integration',
    description: 'Non-human principal for APIs/webhooks, scoped to declared operations.',
    permissions: ['catalog:read', 'request:create', 'request:read.any'],
  },
];

export function allRoleDefinitions(): readonly RoleDef[] {
  return [...PLATFORM_ROLES, ...TENANT_ROLES];
}
