import type { DirectoryAdapter, DirectoryUser } from './index';

/**
 * Directory adapters (`docs/32` §6).
 *
 * The domain owns `DirectoryAdapter` (`integrations/index.ts`); this file is the only place a
 * directory vendor is named. Two implementations:
 *
 *   - **Unsupported** — the default when no directory is configured. It fails the sync rather
 *     than reporting an empty roster, because an empty roster is exactly the input the
 *     deactivation guard exists to catch: an outage must not look like "everyone left".
 *   - **A test fake** — a fixed roster, so the reconciliation rules are exercised without a
 *     network dependency (`docs/37` §3).
 */

export const unsupportedDirectoryAdapter: DirectoryAdapter = {
  async fetchRoster(): Promise<DirectoryUser[]> {
    throw new Error('No directory adapter is configured (docs/32 §6).');
  },
};

/**
 * A deterministic in-memory directory. `scripts` lets a test change the roster between runs
 * (a person joining, a person leaving) while keeping every other value stable.
 */
export function createFakeDirectoryAdapter(users: readonly DirectoryUser[]): {
  adapter: DirectoryAdapter;
  setRoster: (next: readonly DirectoryUser[]) => void;
} {
  let roster: readonly DirectoryUser[] = users;
  const adapter: DirectoryAdapter = {
    async fetchRoster(): Promise<DirectoryUser[]> {
      return roster.map((user) => ({ ...user }));
    },
  };
  return {
    adapter,
    setRoster: (next: readonly DirectoryUser[]) => {
      roster = next;
    },
  };
}

/** Resolves the configured directory adapter. There is none yet, so this is explicit. */
export function createDirectoryAdapter(): DirectoryAdapter {
  // A real deployment wires its provider here (and injects its credential, `docs/32` §7).
  // Until then, the sync reports "not configured" instead of pretending an empty roster.
  return unsupportedDirectoryAdapter;
}

export const directoryAdapter: DirectoryAdapter = createDirectoryAdapter();
