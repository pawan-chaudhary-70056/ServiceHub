import { ValidationError } from './errors';

/**
 * Cursor pagination primitives (docs/11 §6, docs/09 §6).
 *
 * Collections are cursor-paginated, never offset-paginated. Offset pagination degrades
 * linearly and — worse — silently skips or duplicates rows when the underlying data
 * changes between pages, which is a visible correctness bug in a busy ticket queue.
 *
 * The cursor is **opaque** to the client: it encodes a stable, unique, indexed tuple
 * (`sortValue`, `id`) where `id` is the tiebreaker that makes the ordering total. The
 * client must not parse or construct it.
 *
 * Repository usage: fetch `limit + 1` rows in the declared sort order, then call
 * `buildCursorPage`. The extra row is how `hasMore` is known without a second count
 * query — an unbounded or double query is exactly what this module avoids.
 */

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface DecodedCursor {
  /** The sort value to resume after (serialised; the repository parses it per type). */
  sortValue: string;
  /** The unique tiebreaker id. */
  id: string;
}

interface CursorPayload {
  /** sortValue */
  s?: unknown;
  /** id */
  i?: unknown;
}

/**
 * Encodes a `(sortValue, id)` tuple as an opaque token.
 *
 * `base64url` keeps the token URL-safe without escaping. This is obfuscation, not
 * security: the cursor carries no authority, and every query re-applies the caller's
 * tenant and object scope regardless of what the cursor says.
 */
export function encodeCursor(sortValue: string | number | Date, id: string): string {
  const normalized = sortValue instanceof Date ? sortValue.toISOString() : String(sortValue);
  return Buffer.from(JSON.stringify({ s: normalized, i: id }), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, throwing a `422 VALIDATION_FAILED` on anything malformed.
 *
 * A malformed cursor is a client error, not a server error — it must fail closed at the
 * boundary (docs/11 §6 says a malformed cursor returns `422`), never be silently
 * ignored and treated as "start from the beginning".
 */
export function decodeCursor(cursor: string): DecodedCursor {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (typeof payload.s !== 'string' || typeof payload.i !== 'string' || payload.i.length === 0) {
      throw new Error('Unexpected cursor payload shape.');
    }
    return { sortValue: payload.s, id: payload.i };
  } catch {
    throw new ValidationError([
      {
        field: 'query.cursor',
        code: 'INVALID_CURSOR',
        message: 'The pagination cursor is malformed.',
      },
    ]);
  }
}

/**
 * Builds a page from rows fetched with a `limit + 1` overscan.
 *
 * @param rows   up to `limit + 1` rows, already ordered by the sort tuple
 * @param limit  the requested page size (validated: 1–100)
 * @param sortOf the row's sort value, encoded into the next cursor
 */
export function buildCursorPage<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  sortOf: (row: T) => string | number | Date,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : Array.from(rows);
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(sortOf(last), last.id) : null,
  };
}
