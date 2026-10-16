/**
 * E2E actor credentials (docs/37 §7).
 *
 * A journey spans several roles — a requester raises, an approver decides, an agent
 * fulfils — so the suite needs one credential set per role. They come from the
 * environment, never from the repository: a checked-in test password is a checked-in
 * credential, and staging is production-shaped by policy (`docs/35` §1).
 *
 * A journey whose credentials are absent **skips with a reason** rather than failing, so
 * the suite stays runnable on a laptop with no stack while CI, which has the secrets,
 * runs everything. A skip is visible in the report; it is not a silent pass.
 *
 * Required variables, all optional per journey:
 *   E2E_REQUESTER_EMAIL / E2E_REQUESTER_PASSWORD — raises requests and incidents
 *   E2E_AGENT_EMAIL / E2E_AGENT_PASSWORD         — triages, fulfils, resolves
 *   E2E_APPROVER_EMAIL / E2E_APPROVER_PASSWORD   — named as an approver in the fixture template
 *   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD         — `catalog:manage`, `user:manage`
 *   E2E_OUTSIDER_EMAIL / E2E_OUTSIDER_PASSWORD   — a member with no team in the fixture
 */
export interface Credentials {
  email: string;
  password: string;
}

export type ActorName = 'requester' | 'agent' | 'approver' | 'admin' | 'outsider';

function read(name: ActorName): Credentials | null {
  const prefix = `E2E_${name.toUpperCase()}`;
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];
  return email && password ? { email, password } : null;
}

const ACTORS: Record<ActorName, Credentials | null> = {
  requester: read('requester'),
  agent: read('agent'),
  approver: read('approver'),
  admin: read('admin'),
  outsider: read('outsider'),
};

/**
 * The environment variables a journey needs but does not have.
 *
 * Returns names rather than skipping, so the caller can skip at **collection** time — a
 * skip decided inside a test body still builds the `page` fixture first, which fails on a
 * machine with no browser installed. Skipping during collection instead reports an honest
 * "skipped" whose reason names the missing variable.
 */
export function missingActors(names: ActorName[]): string[] {
  return names
    .filter((name) => ACTORS[name] === null)
    .map((name) => `E2E_${name.toUpperCase()}_EMAIL/_PASSWORD`);
}

/** The reason string a skipped journey reports, so the gap is actionable from the report. */
export function skipReason(missing: string[]): string {
  return `Not provisioned: ${missing.join(', ')} are unset, so this journey cannot run. Set them to run it against a staging stack (docs/37 §7).`;
}

/** The credentials of one actor, for a journey that has already called `requireActors`. */
export function actor(name: ActorName): Credentials {
  const credentials = ACTORS[name];
  if (!credentials) {
    // Unreachable after `requireActors`; a throw rather than a silent empty login, so a
    // future caller that forgets the guard fails loudly instead of testing nothing.
    throw new Error(`E2E_${name.toUpperCase()}_EMAIL/_PASSWORD are not configured.`);
  }
  return credentials;
}
