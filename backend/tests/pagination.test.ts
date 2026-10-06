import { describe, expect, it } from 'vitest';
import { buildCursorPage, decodeCursor, encodeCursor } from '../src/utils/pagination';
import { ValidationError } from '../src/utils/errors';

/**
 * Cursor pagination (docs/11 §6, docs/09 §6).
 *
 * The behaviour worth locking down is the correctness property that offset pagination
 * cannot provide: the cursor is a stable, reproducible resume point, and a malformed
 * cursor fails closed with `422` rather than silently restarting the list.
 */
describe('cursor encode/decode', () => {
  it('round-trips a tuple and treats the token as opaque', () => {
    const cursor = encodeCursor('2026-10-01T00:00:00.000Z', 'req_123');

    expect(typeof cursor).toBe('string');
    expect(cursor).not.toContain('req_123'); // opaque, not a raw id
    expect(decodeCursor(cursor)).toEqual({
      sortValue: '2026-10-01T00:00:00.000Z',
      id: 'req_123',
    });
  });

  it('normalises a Date sort value to ISO', () => {
    const at = new Date('2026-10-01T12:00:00.000Z');
    expect(decodeCursor(encodeCursor(at, 'req_1')).sortValue).toBe(at.toISOString());
  });

  it('rejects a malformed cursor with a 422 validation error, never a restart', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(ValidationError);

    try {
      decodeCursor('!!!');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('VALIDATION_FAILED');
      expect((error as ValidationError).details?.[0]).toMatchObject({ field: 'query.cursor' });
    }
  });
});

describe('buildCursorPage', () => {
  const rows = [
    { id: 'a', createdAt: '2026-01-03' },
    { id: 'b', createdAt: '2026-01-02' },
    { id: 'c', createdAt: '2026-01-01' },
  ];

  it('reports hasMore and a resume cursor when an overscan row is present', () => {
    // Fetch limit + 1 = 3 rows for a limit of 2.
    const page = buildCursorPage(rows, 2, (row) => row.createdAt);

    expect(page.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    if (page.nextCursor) {
      expect(decodeCursor(page.nextCursor)).toEqual({ sortValue: '2026-01-02', id: 'b' });
    }
  });

  it('reports the final page with no cursor when the overscan is absent', () => {
    const page = buildCursorPage(rows.slice(0, 2), 2, (row) => row.createdAt);

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result without inventing a cursor', () => {
    const page = buildCursorPage<{ id: string; createdAt: string }>([], 25, (row) => row.createdAt);

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
