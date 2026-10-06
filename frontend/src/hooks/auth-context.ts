import { createContext, useContext } from 'react';
import type { AuthenticatedUser } from '../api/auth.api';

/**
 * The identity context (docs/14 §session state).
 *
 * Kept separate from the provider component so this module exports no component and the
 * provider file exports only its component — that is what React Fast Refresh requires,
 * and it also makes the "is this a hook or a component?" question unambiguous.
 *
 * The context holds **session state only** — who the caller is and what they hold. It is
 * never an authorization control: the server decides what the caller may do, and a
 * hidden button backed by an unguarded endpoint is a defect (docs/07, docs/17).
 */
export interface AuthContextValue {
  user: AuthenticatedUser | null;
  permissions: readonly string[];
  /** True while the initial `GET /auth/me` is in flight. */
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Whether the caller holds a permission. A UI hint, never a control (docs/07). */
  hasPermission: (permission: string) => boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    // A missing provider is a programming error, not a runtime state. Failing loudly is
    // how it is found during development instead of as a confusing undefined render.
    throw new Error('useAuth must be used within an AuthProvider.');
  }
  return context;
}
