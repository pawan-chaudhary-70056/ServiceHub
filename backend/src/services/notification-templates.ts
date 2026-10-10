import { config } from '../config';
import { OUTBOX_EVENT } from './audit-events';

/**
 * Notification templates (`docs/29` §8).
 *
 * A template is versioned and renders a domain event's payload into channel content. Three
 * rules from `docs/29` §8 are enforced here:
 *
 *   - **User-supplied values are escaped** before they reach the HTML body (`docs/17`), so
 *     an address or a title cannot inject markup.
 *   - **Every HTML body has a plain-text alternative.**
 *   - **A domain event names people, never addresses.** A payload carries ids, so the
 *     recipient's address is resolved at send time from the user row
 *     (`recipientUserIds`) rather than frozen into the queue. A re-pointed mailbox then
 *     receives the next notification instead of the old address, and the payload stays
 *     free of personal data at rest (`docs/19` §3). Only the two onboarding events, whose
 *     recipient by definition has no account yet, carry an address in the payload.
 *
 * Subjects deliberately avoid sensitive data: a subject appears on a lock screen.
 *
 * This is a leaf module (no database, no HTTP), so the worker, the tests and a future
 * template-preview surface all render the same way. Recipient *resolution* (id → address)
 * is the worker's job; this module only declares which ids matter.
 */

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

export interface NotificationTemplate {
  /** Bumped when the copy or structure changes (`docs/29` N9). Recorded on every send. */
  version: string;
  eventType: string;
  /**
   * An address written directly into the payload. Present only for the onboarding events
   * (invitation, password reset), whose recipient has no user row to resolve yet.
   */
  recipient?(payload: Record<string, unknown>): string | null;
  /**
   * Payload user-id keys whose holders are the recipients, resolved to addresses at send
   * time. Several ids is normal — an approval step has a list of approvers.
   */
  recipientUserIds?(payload: Record<string, unknown>): string[];
  render(payload: Record<string, unknown>): RenderedMessage;
}

/** Escapes the five HTML-significant characters (`docs/17`, docs/29 §8). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads string-or-array fields into a de-duplicated, non-empty id list. */
function idList(payload: Record<string, unknown>, keys: readonly string[]): string[] {
  const values = new Set<string>();
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.length > 0) values.add(raw);
    if (Array.isArray(raw)) {
      for (const entry of raw) if (typeof entry === 'string' && entry.length > 0) values.add(entry);
    }
  }
  return [...values];
}

/** An absolute link into the SPA, so an email is actionable (`docs/29` §8). */
function recordUrl(path: string): string {
  return `${config.APP_BASE_URL.replace(/\/$/, '')}${path}`;
}

/** A minimal, accessible shell shared by every HTML email. */
function wrapHtml(title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>',
    escapeHtml(title),
    '</title></head>',
    '<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">',
    bodyHtml,
    '</body></html>',
  ].join('');
}

const INVITATION: NotificationTemplate = {
  version: 'v1',
  eventType: OUTBOX_EVENT.INVITATION_CREATED,
  recipient: (payload) => stringField(payload, 'email'),
  render: (payload) => {
    const acceptUrl = stringField(payload, 'acceptUrl') ?? '';
    const expiresAt = stringField(payload, 'expiresAt');
    const expiry = expiresAt ? new Date(expiresAt).toUTCString() : null;
    return {
      subject: 'You have been invited to ServiceHub',
      text: [
        'You have been invited to ServiceHub.',
        '',
        'Set your password and activate your account:',
        acceptUrl,
        ...(expiry ? ['', `This link expires on ${expiry}.`] : []),
        '',
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n'),
      html: wrapHtml(
        'You have been invited to ServiceHub',
        [
          '<p>You have been invited to ServiceHub.</p>',
          `<p><a href="${escapeHtml(acceptUrl)}">Set your password and activate your account</a></p>`,
          ...(expiry ? [`<p>This link expires on ${escapeHtml(expiry)}.</p>`] : []),
          '<p>If you were not expecting this invitation, you can ignore this email.</p>',
        ].join(''),
      ),
    };
  },
};

const PASSWORD_RESET: NotificationTemplate = {
  version: 'v1',
  eventType: OUTBOX_EVENT.PASSWORD_RESET_REQUESTED,
  recipient: (payload) => stringField(payload, 'email'),
  render: (payload) => {
    const resetUrl = stringField(payload, 'resetUrl') ?? '';
    const expiresAt = stringField(payload, 'expiresAt');
    const expiry = expiresAt ? new Date(expiresAt).toUTCString() : null;
    return {
      subject: 'Reset your ServiceHub password',
      text: [
        'A password reset was requested for your ServiceHub account.',
        '',
        'Choose a new password:',
        resetUrl,
        ...(expiry ? ['', `This link expires on ${expiry}.`] : []),
        '',
        'If you did not request this, no action is needed — your password is unchanged.',
      ].join('\n'),
      html: wrapHtml(
        'Reset your ServiceHub password',
        [
          '<p>A password reset was requested for your ServiceHub account.</p>',
          `<p><a href="${escapeHtml(resetUrl)}">Choose a new password</a></p>`,
          ...(expiry ? [`<p>This link expires on ${escapeHtml(expiry)}.</p>`] : []),
          '<p>If you did not request this, no action is needed — your password is unchanged.</p>',
        ].join(''),
      ),
    };
  },
};

// ---------------------------------------------------------------------------
// Domain events (`docs/29` §5)
// ---------------------------------------------------------------------------

interface RecordEmailSpec {
  eventType: string;
  /** Subject and heading. Deliberately free of incidental personal data. */
  subject: string;
  intro: string;
  /** SPA path prefix, e.g. `/requests`; joined with `idKey` into one absolute link. */
  linkPath: string;
  /** The payload key holding the record id. */
  idKey: string;
  linkLabel: string;
  /** Payload keys naming the recipients (a single id or an array of ids). */
  recipients: readonly string[];
  /** Optional `Label: value` lines taken from payload string fields. */
  fields?: readonly { label: string; key: string }[];
  footnote?: string;
}

/**
 * Builds the email for a record lifecycle event: who it is for, what happened, and a link
 * to the record. Written once so the ten domain emails cannot drift in structure (and so
 * every one of them escapes its interpolations and ships a text alternative).
 */
function recordTemplate(spec: RecordEmailSpec): NotificationTemplate {
  return {
    version: 'v1',
    eventType: spec.eventType,
    recipientUserIds: (payload) => idList(payload, spec.recipients),
    render: (payload) => {
      const id = stringField(payload, spec.idKey);
      const url = id ? recordUrl(`${spec.linkPath}/${id}`) : null;
      const details = (spec.fields ?? [])
        .map(({ label, key }) => {
          const value = stringField(payload, key);
          return value ? `${label}: ${value}` : null;
        })
        .filter((line): line is string => line !== null);
      return {
        subject: spec.subject,
        text: [
          spec.intro,
          ...(details.length > 0 ? ['', ...details] : []),
          ...(url ? ['', `${spec.linkLabel}:`, url] : []),
          ...(spec.footnote ? ['', spec.footnote] : []),
        ].join('\n'),
        html: wrapHtml(
          spec.subject,
          [
            `<p>${escapeHtml(spec.intro)}</p>`,
            ...details.map((line) => `<p>${escapeHtml(line)}</p>`),
            ...(url
              ? [`<p><a href="${escapeHtml(url)}">${escapeHtml(spec.linkLabel)}</a></p>`]
              : []),
            ...(spec.footnote ? [`<p>${escapeHtml(spec.footnote)}</p>`] : []),
          ].join(''),
        ),
      };
    },
  };
}

// Assignments — the assignee is told work is waiting on them (`docs/29` §5).
const REQUEST_ASSIGNED = recordTemplate({
  eventType: OUTBOX_EVENT.REQUEST_ASSIGNED,
  subject: 'A request was assigned to you',
  intro: 'You have been assigned a service request.',
  linkPath: '/requests',
  idKey: 'requestId',
  linkLabel: 'Open the request',
  recipients: ['assigneeId'],
});

const INCIDENT_ASSIGNED = recordTemplate({
  eventType: OUTBOX_EVENT.INCIDENT_ASSIGNED,
  subject: 'An incident was assigned to you',
  intro: 'You have been assigned an incident.',
  linkPath: '/incidents',
  idKey: 'incidentId',
  linkLabel: 'Open the incident',
  recipients: ['assigneeId'],
});

const TASK_ASSIGNED = recordTemplate({
  eventType: OUTBOX_EVENT.TASK_ASSIGNED,
  subject: 'A task was assigned to you',
  intro: 'You have been assigned a task.',
  linkPath: '/tasks',
  idKey: 'taskId',
  linkLabel: 'Open the task',
  recipients: ['assigneeId'],
});

const TASK_CREATED = recordTemplate({
  eventType: OUTBOX_EVENT.TASK_CREATED,
  subject: 'A task was raised on your work',
  intro: 'A task was created and assigned to you.',
  linkPath: '/tasks',
  idKey: 'taskId',
  linkLabel: 'Open the task',
  recipients: ['assigneeId'],
});

// Approvals — the approver list is the recipient list (A1: every step approver decides).
const APPROVAL_REQUESTED = recordTemplate({
  eventType: OUTBOX_EVENT.APPROVAL_REQUESTED,
  subject: 'An approval is waiting on you',
  intro: 'A request is waiting for your approval decision.',
  linkPath: '/requests',
  idKey: 'requestId',
  linkLabel: 'Review the request',
  recipients: ['approverIds'],
});

const APPROVAL_STEP_ADVANCED = recordTemplate({
  eventType: OUTBOX_EVENT.APPROVAL_STEP_ADVANCED,
  subject: 'An approval advanced to you',
  intro: 'A request has advanced to a step you approve.',
  linkPath: '/requests',
  idKey: 'requestId',
  linkLabel: 'Review the request',
  recipients: ['approverIds'],
});

const APPROVAL_REASSIGNED = recordTemplate({
  eventType: OUTBOX_EVENT.APPROVAL_REASSIGNED,
  subject: 'An approval step was reassigned to you',
  intro: 'An approval step was reassigned to you.',
  linkPath: '/requests',
  idKey: 'requestId',
  linkLabel: 'Review the request',
  recipients: ['approverIds'],
  fields: [{ label: 'Reference', key: 'reference' }],
});

// Outcomes — the requester learns the decision without opening the app.
const APPROVAL_APPROVED = recordTemplate({
  eventType: OUTBOX_EVENT.APPROVAL_APPROVED,
  subject: 'Your request was approved',
  intro: 'Your service request was approved.',
  linkPath: '/requests',
  idKey: 'requestId',
  linkLabel: 'Open the request',
  recipients: ['requesterId'],
  fields: [{ label: 'Reference', key: 'reference' }],
});

const APPROVAL_REJECTED = recordTemplate({
  eventType: OUTBOX_EVENT.APPROVAL_REJECTED,
  subject: 'Your request was rejected',
  intro: 'Your service request was rejected.',
  linkPath: '/requests',
  idKey: 'requestId',
  linkLabel: 'Open the request',
  recipients: ['requesterId'],
  fields: [{ label: 'Reference', key: 'reference' }],
});

const INCIDENT_RESOLVED = recordTemplate({
  eventType: OUTBOX_EVENT.INCIDENT_RESOLVED,
  subject: 'Your incident was resolved',
  intro: 'The incident you reported has been resolved.',
  linkPath: '/incidents',
  idKey: 'incidentId',
  linkLabel: 'Open the incident',
  recipients: ['reporterId'],
  fields: [{ label: 'Reference', key: 'reference' }],
});

const TEMPLATES: readonly NotificationTemplate[] = [
  INVITATION,
  PASSWORD_RESET,
  REQUEST_ASSIGNED,
  INCIDENT_ASSIGNED,
  TASK_ASSIGNED,
  TASK_CREATED,
  APPROVAL_REQUESTED,
  APPROVAL_STEP_ADVANCED,
  APPROVAL_REASSIGNED,
  APPROVAL_APPROVED,
  APPROVAL_REJECTED,
  INCIDENT_RESOLVED,
];

/** Looks up the template for an event type, or `null` when none is registered yet. */
export function resolveNotificationTemplate(eventType: string): NotificationTemplate | null {
  return TEMPLATES.find((template) => template.eventType === eventType) ?? null;
}

/** Exposed for tests and a future template-preview surface. */
export const NOTIFICATION_TEMPLATES = TEMPLATES;
