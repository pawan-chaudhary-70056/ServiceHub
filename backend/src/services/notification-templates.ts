import { OUTBOX_EVENT } from './audit-events';

/**
 * Notification templates (`docs/29` §8).
 *
 * A template is versioned and renders a domain event's payload into channel content. Two
 * rules from `docs/29` §8 are enforced here:
 *
 *   - **User-supplied values are escaped** before they reach the HTML body (`docs/17`), so
 *     an address or a title cannot inject markup.
 *   - **Every HTML body has a plain-text alternative.**
 *
 * Subjects deliberately avoid sensitive data: a subject appears on a lock screen.
 *
 * This is a leaf module (no database, no HTTP), so the worker, the tests and a future
 * template-preview surface all render the same way.
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
  /** The destination address for this event, or `null` when the payload cannot yield one. */
  recipient(payload: Record<string, unknown>): string | null;
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

const TEMPLATES: readonly NotificationTemplate[] = [INVITATION, PASSWORD_RESET];

/** Looks up the template for an event type, or `null` when none is registered yet. */
export function resolveNotificationTemplate(eventType: string): NotificationTemplate | null {
  return TEMPLATES.find((template) => template.eventType === eventType) ?? null;
}

/** Exposed for tests and a future template-preview surface. */
export const NOTIFICATION_TEMPLATES = TEMPLATES;
