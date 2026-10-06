import { apiRequest } from './client';

/** Teams read model (docs/07). Used by pickers that route work, e.g. a catalog item's fulfilment team. */

export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export function listTeams(signal?: AbortSignal): Promise<{ items: TeamSummary[] }> {
  return apiRequest<{ items: TeamSummary[] }>('/teams', { signal });
}
