import { describe, expect, it } from 'vitest';
import { resolveNotificationTemplate } from '../src/services';

/**
 * Notification template rendering — unit tests (docs/37 §2, docs/29 §8).
 *
 * The security-relevant behaviour is escaping: a user-supplied value must not become
 * markup in the HTML body (docs/17). The plain-text alternative must always be present.
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
    expect(template!.recipient({ email: 'a@b.test' })).toBe('a@b.test');
    expect(template!.recipient({})).toBeNull();
  });

  it('returns null for an event with no registered template', () => {
    expect(resolveNotificationTemplate('notification.not.registered')).toBeNull();
  });
});
