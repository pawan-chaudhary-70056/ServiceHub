/**
 * Truncates an identifier for display (docs/16 — dense tables).
 *
 * Audit entries reference actors and entities by opaque id. The full value is still
 * available in the element's `title`, so truncation is a presentation choice and never
 * discards the identifier.
 */
export function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
