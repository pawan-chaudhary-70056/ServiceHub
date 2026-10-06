import { apiRequest } from './client';

/**
 * Health endpoints, used by the shell to show whether the API is reachable.
 *
 * Liveness and readiness answer different questions and the UI should use the right
 * one: liveness means "the process is alive", readiness means "it can serve traffic"
 * (docs/34 §6). The shell asks for readiness, because that is what determines whether
 * the user's next action will work.
 */

export interface DependencyStatus {
  name: string;
  status: 'up' | 'down' | 'not_configured';
  detail?: string;
}

export interface LivenessResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ready';
  checks: DependencyStatus[];
}

export function fetchLiveness(signal?: AbortSignal): Promise<LivenessResponse> {
  return apiRequest<LivenessResponse>('/health/live', { signal });
}

/**
 * Readiness. Note that this legitimately rejects with a 503 `ApiError` when a
 * dependency is down — that is a valid, expected answer, not a bug in the caller, so
 * the hook treats it as data rather than as a thrown failure.
 */
export function fetchReadiness(signal?: AbortSignal): Promise<ReadinessResponse> {
  return apiRequest<ReadinessResponse>('/health/ready', { signal });
}
