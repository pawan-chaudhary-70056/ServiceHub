import { useCallback, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  type MeResponse,
} from '../api/auth.api';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';

/**
 * Supplies identity to the tree (docs/14).
 *
 * The single source of truth is `GET /auth/me`: it is re-read from the database on the
 * server per request (`docs/06 §7`), so the client cannot drift into believing it still
 * holds a permission that was revoked. A `401` is not an error here — it is the normal
 * "not signed in" answer — so it is narrowed into `null` data rather than a thrown
 * failure that would paint an error state on every logged-out page load.
 */
const ME_QUERY_KEY = ['auth', 'me'] as const;

export interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const queryClient = useQueryClient();

  const me = useQuery<MeResponse | null>({
    queryKey: ME_QUERY_KEY,
    queryFn: async ({ signal }) => {
      try {
        return await fetchMe(signal);
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthenticated) {
          return null;
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const signIn = useCallback<AuthContextValue['signIn']>(
    async (email, password) => {
      const session = await loginRequest(email, password);
      // Seed the cache from the login response so the shell updates without a second
      // round trip. `status` is present on `me` but not on the login response; the
      // server only issues a session to an ACTIVE identity, so it is known here.
      queryClient.setQueryData<MeResponse>(ME_QUERY_KEY, {
        user: { ...session.user, status: 'ACTIVE' },
        permissions: session.permissions,
      });
    },
    [queryClient],
  );

  const signOut = useCallback<AuthContextValue['signOut']>(async () => {
    try {
      await logoutRequest();
    } finally {
      // Clear regardless of the network outcome: leaving cached identity behind after
      // the user asked to sign out is worse than a harmless no-op revocation retry.
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const user = me.data?.user ?? null;
    const permissions = me.data?.permissions ?? [];

    return {
      user,
      permissions,
      isLoading: me.isLoading,
      isAuthenticated: user !== null,
      hasPermission: (permission) => permissions.includes(permission),
      signIn,
      signOut,
    };
  }, [me.data, me.isLoading, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
