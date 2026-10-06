import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { fetchReadiness, type ReadinessResponse } from '../api/health.api';

/**
 * API health, for the shell's status strip.
 *
 * A 503 from the readiness endpoint is a *successful* answer to the question "is the
 * API ready?" — the answer is simply "no". Treating it as a thrown failure would show
 * the user a generic error for a state the server described precisely, so the query
 * narrows that case into data.
 */
export interface HealthStatus {
  ready: boolean;
  checks: { name: string; status: string; detail?: string }[];
  /** Set when the API could not be reached at all, as opposed to reporting not-ready. */
  unreachable: boolean;
}

export function useHealth(): UseQueryResult<HealthStatus, Error> {
  return useQuery({
    queryKey: ['health', 'readiness'],
    queryFn: async ({ signal }): Promise<HealthStatus> => {
      try {
        const response: ReadinessResponse = await fetchReadiness(signal);
        return { ready: true, checks: response.checks, unreachable: false };
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) {
          return { ready: false, checks: [], unreachable: false };
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        return { ready: false, checks: [], unreachable: true };
      }
    },
    staleTime: 15_000,
  });
}
