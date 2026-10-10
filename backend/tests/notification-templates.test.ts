import { describe, expect, it } from 'vitest';
import { resolveNotificationTemplate } from '../src/services';

/**
 * Notification template rendering — unit tests (docs/37 §2, docs/29 §8).
 *
 * Two behaviours are security- or contract-relevant and are asserted here:
 *
 *   - **Escaping**: a user-supplied value must not become markup in the HTML body
 *     (docs/17), and the plain-text alternative must always be present.
 *   - **Recipient declaration**: an event names people by id, resolved to an address at
 *     send time. A template that returned an address it invented, or dropped a recipient,
 *     would be a silent delivery bug — so the declared ids are asserted directly.
 */

describe('notification templates', () => {
  it('escapes markup in user-supplied URLs (docs/29 §8)', () => {
    const template = resolveNotificationTemplate('notification.invitation.created');
    expect(template).not.toBeNull();
    const rendered = template!.render({
      email: 'someone@example.test',
      acceptUrl: 'https://example.test/accept?token="><script>alert(1)</script>',
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&quot;&gt;&lt;script&gt;');
    // The plain-text part is not HTML and keeps the raw value.
    expect(rendered.text).toContain('<script>');
  });

  it('extracts the recipient from the payload and returns null when absent', () => {
    const template = resolveNotificationTemplate('notification.password.reset');
    expect(template!.recipient!({ email: 'a@b.test' })).toBe('a@b.test');
    expect(template!.recipient!({})).toBeNull();
  });

  it('returns null for an event with no registered template', () => {
    expect(resolveNotificationTemplate('notification.not.registered')).toBeNull();
  });

  it('declares every recipient-bearing domain event (docs/29 §5)', () => {
    const cases: Array<{ eventType: string; payload: Record<string, unknown>; ids: string[] }> = [
      {
        eventType: 'notification.request.assigned',
        payload: { requestId: 'r1', assigneeId: 'u-assignee' },
        ids: ['u-assignee'],
      },
      {
        eventType: 'notification.incident.assigned',
        payload: { incidentId: 'i1', assigneeId: 'u-assignee' },
        ids: ['u-assignee'],
      },
      {
        eventType: 'notification.task.assigned',
        payload: { taskId: 't1', assigneeId: 'u-assignee' },
        ids: ['u-assignee'],
      },
      {
        eventType: 'notification.task.created',
        payload: { taskId: 't1', assigneeId: 'u-assignee' },
        ids: ['u-assignee'],
      },
      {
        eventType: 'notification.incident.resolved',
        payload: { incidentId: 'i1', reference: 'INC-1', reporterId: 'u-reporter' },
        ids: ['u-reporter'],
      },
      {
        eventType: 'notification.approval.approved',
        payload: { requestId: 'r1', requesterId: 'u-requester' },
        ids: ['u-requester'],
      },
      {
        eventType: 'notification.approval.rejected',
        payload: { requestId: 'r1', requesterId: 'u-requester' },
        ids: ['u-requester'],
      },
      {
        // A step has a list of approvers, so several recipients is the normal case.
        eventType: 'notification.approval.requested',
        payload: { requestId: 'r1', approverIds: ['u-a', 'u-b'] },
        ids: ['u-a', 'u-b'],
      },
      {
        eventType: 'notification.approval.step_advanced',
        payload: { requestId: 'r1', approverIds: ['u-b'] },
        ids: ['u-b'],
      },
      {
        eventType: 'notification.approval.reassigned',
        payload: { requestId: 'r1', approverIds: ['u-c'] },
        ids: ['u-c'],
      },
    ];

    for (const testCase of cases) {
      const template = resolveNotificationTemplate(testCase.eventType);
      expect(template, testCase.eventType).not.toBeNull();
      expect(template!.recipientUserIds!(testCase.payload), testCase.eventType).toEqual(
        testCase.ids,
      );
      // A domain event never carries an address, only ids.
      expect(template!.recipient?.(testCase.payload) ?? null, testCase.eventType).toBeNull();
    }
  });

  it('links to the record and carries a text alternative (docs/29 §8)', () => {
    const template = resolveNotificationTemplate('notification.incident.resolved');
    const rendered = template!.render({
      incidentId: 'i-42',
      reference: 'INC-0042',
      reporterId: 'u-reporter',
    });

    expect(rendered.subject).toBe('Your incident was resolved');
    expect(rendered.text).toContain('Reference: INC-0042');
    expect(rendered.text).toContain('/incidents/i-42');
    expect(rendered.html).toContain('href=');
    expect(rendered.html).toContain('/incidents/i-42');
    // Text and HTML must both exist: a mail client may render either.
    expect(rendered.text.length).toBeGreaterThan(rendered.subject.length);
    expect(rendered.html.startsWith('<!doctype html>')).toBe(true);
  });

  it('escapes a reference interpolated into HTML (docs/17)', () => {
    const template = resolveNotificationTemplate('notification.approval.approved');
    const rendered = template!.render({
      requestId: 'r1',
      requesterId: 'u1',
      reference: '<img src=x onerror=alert(1)>',
    });
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('&lt;img');
  });

  it('renders without a link when the payload carries no record id', () => {
    const template = resolveNotificationTemplate('notification.incident.resolved');
    const rendered = template!.render({ reporterId: 'u1' });
    expect(rendered.text).not.toContain('http');
    expect(rendered.html).not.toContain('href=');
  });
});
