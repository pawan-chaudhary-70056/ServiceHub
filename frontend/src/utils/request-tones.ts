import type { Tone } from '../themes/tokens';
import type { Priority, RequestStatus } from '../api/requests.api';
import type { IncidentStatus } from '../api/incidents.api';

/**
 * Shared tone mapping for request status and priority.
 *
 * Kept in one module so a status renders the same colour in the list and the detail view —
 * a state that is amber in one place and grey in another destroys trust in the colour
 * (docs/16). Colour is never the only signal: the badge always renders the label too.
 */
export function statusTone(status: RequestStatus): Tone {
  if (status === 'CLOSED' || status === 'FULFILLED' || status === 'APPROVED') return 'success';
  if (status === 'CANCELLED' || status === 'REJECTED') return 'danger';
  if (status === 'APPROVAL_PENDING' || status === 'NEW') return 'warning';
  if (status === 'IN_PROGRESS' || status === 'TRIAGED') return 'info';
  return 'neutral';
}

export function priorityTone(priority: Priority): Tone {
  if (priority === 'CRITICAL') return 'danger';
  if (priority === 'HIGH') return 'warning';
  if (priority === 'MEDIUM') return 'info';
  return 'neutral';
}

/**
 * Tone for incident states (docs/23 §11). A disruption that has just been reported (NEW)
 * reads as danger — it is unacknowledged — while a CLOSED incident reads as success.
 */
export function incidentStatusTone(status: IncidentStatus): Tone {
  if (status === 'CLOSED') return 'success';
  if (status === 'RESOLVED') return 'info';
  if (status === 'IN_PROGRESS') return 'warning';
  return 'danger';
}
