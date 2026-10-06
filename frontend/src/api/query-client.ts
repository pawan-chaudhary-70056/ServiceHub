import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

/**
 * Server-state configuration (docs/14, docs/40).
 *
 * The defaults are chosen rather than inherited, because the wrong ones cause two
 * distinct problems in this application:
 *
 *   - Retrying a 4xx is pointless and hides the error from the user for seconds. A
 *     validation failure or a permission denial will never succeed on retry, so only
 *     transient (5xx / network) failures are retried.
 *   - A refetch on every window focus turns a service desk — which is open all day —
 *     into a steady background load that is invisible in development and obvious in
 *     production. Focus refetching is therefore off, and screens that need freshness
 *     opt in.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry a decision the server already made about this request.
        if (error instanceof ApiError && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      // A mutation must not be silently retried: it may already have succeeded, and
      // repeating a non-idempotent operation duplicates its effect (docs/03 §8).
      retry: false,
    },
  },
});
