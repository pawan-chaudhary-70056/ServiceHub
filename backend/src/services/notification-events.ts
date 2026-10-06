import { OUTBOX_EVENT } from './audit-events';

/**
 * The notification event catalogue (`docs/29` §5, §7).
 *
 * Every outbox event type is classified here so the preference rules of `docs/29` §7 can be
 * enforced in one place:
 *
 *   - **TRANSACTIONAL** — never opt-out (`29` N6): a password reset or an approval assigned
 *     to you is the only warning of a security or correctness event. The preference API
 *     refuses to silence one.
 *   - **OPERATIONAL** — opt out per event and per channel.
 *   - **INFORMATIONAL** — opt out, digestible.
 *
 * The catalogue also declares which events surface in the **in-app centre** and how to
 * derive their recipients from the event payload. An event whose payload carries no
 * recipient id is email-only for now; making it in-app is a payload change in the owning
 * service, named in the `docs/43` entry rather than faked here.
 */

export type NotificationClass = 'TRANSACTIONAL' | 'OPERATIONAL' | 'INFORMATIONAL';
export type NotificationChannel = 'EMAIL' | 'SMS' | 'IN_APP';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['EMAIL', 'SMS', 'IN_APP'];

export interface InAppDefinition {
  title: string;
  /** A link into the SPA for the referenced record, or null. */
  link: (payload: Record<string, unknown>) => string | null;
}

export interface EventDefinition {
  eventType: string;
  class: NotificationClass;
  /** Present when the event is surfaced in-app and a recipient can be resolved. */
  inApp?: InAppDefinition;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Recipients for the in-app channel, read from the payload. Deliberately generic: an event
 * that names an assignee, requester, reporter or approver list is in-app notifiable.
 */
export function inAppRecipientIds(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of ['assigneeId', 'requesterId', 'reporterId'] as const) {
    const value = stringField(payload, key);
    if (value) ids.add(value);
  }
  const approvers = payload.approverIds;
  if (Array.isArray(approvers)) {
    for (const id of approvers) if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return [...ids];
}

function recordLink(
  prefix: string,
  idKey: string,
): (payload: Record<string, unknown>) => string | null {
  return (payload) => {
    const id = stringField(payload, idKey);
    return id ? `${prefix}/${id}` : null;
  };
}

/** The catalogue. Events absent here cannot be opted out of and are not surfaced in-app. */
const DEFINITIONS: readonly EventDefinition[] = [
  // Transactional — never opt-out (`29` N6).
  { eventType: OUTBOX_EVENT.INVITATION_CREATED, class: 'TRANSACTIONAL' },
  { eventType: OUTBOX_EVENT.PASSWORD_RESET_REQUESTED, class: 'TRANSACTIONAL' },

  // Approvals — operational, in-app to the step's approvers.
  {
    eventType: OUTBOX_EVENT.APPROVAL_REQUESTED,
    class: 'OPERATIONAL',
    inApp: { title: 'An approval is waiting on you', link: recordLink('/requests', 'requestId') },
  },
  {
    eventType: OUTBOX_EVENT.APPROVAL_STEP_ADVANCED,
    class: 'OPERATIONAL',
    inApp: { title: 'An approval advanced to you', link: recordLink('/requests', 'requestId') },
  },
  {
    eventType: OUTBOX_EVENT.APPROVAL_REASSIGNED,
    class: 'OPERATIONAL',
    inApp: {
      title: 'An approval step was reassigned to you',
      link: recordLink('/requests', 'requestId'),
    },
  },
  { eventType: OUTBOX_EVENT.APPROVAL_APPROVED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.APPROVAL_REJECTED, class: 'OPERATIONAL' },

  // Requests and incidents — operational, in-app to the assignee.
  {
    eventType: OUTBOX_EVENT.REQUEST_ASSIGNED,
    class: 'OPERATIONAL',
    inApp: { title: 'A request was assigned to you', link: recordLink('/requests', 'requestId') },
  },
  { eventType: OUTBOX_EVENT.REQUEST_CREATED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.REQUEST_STATUS_CHANGED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.COMMENT_ADDED, class: 'OPERATIONAL' },
  {
    eventType: OUTBOX_EVENT.INCIDENT_ASSIGNED,
    class: 'OPERATIONAL',
    inApp: {
      title: 'An incident was assigned to you',
      link: recordLink('/incidents', 'incidentId'),
    },
  },
  { eventType: OUTBOX_EVENT.INCIDENT_REPORTED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.INCIDENT_RESOLVED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.INCIDENT_REOPENED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.INCIDENT_PRIORITY_OVERRIDDEN, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.INCIDENT_MAJOR_DECLARED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.INCIDENT_MAJOR_CLEARED, class: 'OPERATIONAL' },

  // Tasks — operational, in-app to the assignee.
  {
    eventType: OUTBOX_EVENT.TASK_ASSIGNED,
    class: 'OPERATIONAL',
    inApp: { title: 'A task was assigned to you', link: recordLink('/tasks', 'taskId') },
  },
  { eventType: OUTBOX_EVENT.TASK_CREATED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.TASK_BLOCKED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.TASK_COMPLETED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.TASK_CANCELLED, class: 'OPERATIONAL' },
  { eventType: OUTBOX_EVENT.TASK_ROLLUP_OVERRIDE, class: 'OPERATIONAL' },

  // SLA — operational, in-app where the payload names an assignee.
  {
    eventType: OUTBOX_EVENT.SLA_AT_RISK,
    class: 'OPERATIONAL',
    inApp: {
      title: 'An SLA target is at risk',
      link: (payload) => recordLink('/', 'entityId')(payload),
    },
  },
  {
    eventType: OUTBOX_EVENT.SLA_BREACHED,
    class: 'OPERATIONAL',
    inApp: {
      title: 'An SLA target was breached',
      link: (payload) => recordLink('/', 'entityId')(payload),
    },
  },
];

const BY_TYPE = new Map(DEFINITIONS.map((definition) => [definition.eventType, definition]));

export function getEventDefinition(eventType: string): EventDefinition | null {
  return BY_TYPE.get(eventType) ?? null;
}

/** A transactional event cannot be silenced (`29` N6). */
export function isMandatory(eventType: string): boolean {
  return BY_TYPE.get(eventType)?.class === 'TRANSACTIONAL';
}

export function listEventDefinitions(): readonly EventDefinition[] {
  return DEFINITIONS;
}
