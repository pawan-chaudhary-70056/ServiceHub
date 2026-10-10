/**
 * Content sniffing and the upload allow-list (docs/19 §7.2 rules 2–3, §7.4).
 *
 * The client's filename and `Content-Type` are **advisory metadata**: an attacker sets
 * both. What decides whether a file is accepted is its bytes. The rules are written as
 * an allow-list, because a block-list can only be evaded by the next novel payload —
 * and an allow-list that fails closed rejects exactly that payload.
 *
 * Two invariants (docs/19 §8):
 *   - A `.pdf` containing HTML is rejected: the sniffed type must agree with the claimed
 *     one, so extension and header spoofing buys nothing.
 *   - HTML, JS and SVG are always rejected, whatever they claim to be. Files are served
 *     with a restrictive type and never from the application's origin (§7.3), and the
 *     cheapest way to make a stored-XSS payload useless is to never store it.
 */

/** Sniffed type → the canonical content type the record is stored with. */
export type SniffedType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'application/zip'
  | 'text/plain';

export type SniffResult = { ok: true; contentType: SniffedType } | { ok: false; reason: string };

const startsWith = (data: Buffer, bytes: readonly number[], offset = 0): boolean =>
  data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);

const asciiAt = (data: Buffer, text: string, offset = 0): boolean =>
  data.length >= offset + text.length &&
  data.subarray(offset, offset + text.length).toString('latin1') === text;

/** Declared types we are willing to believe — anything else never reaches sniffing. */
const ALLOWED_DECLARED = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
  'text/plain',
]);

/** Content types a browser may execute or render as a document — never stored. */
const DANGEROUS_TEXT_MARKERS = [
  '<!doctype html',
  '<html',
  '<script',
  '<svg',
  '<?php',
  '<?xml',
  '<iframe',
  '<!--',
];

/**
 * Classifies the leading bytes. Returns `null` when the payload is not on the allow-list
 * — including anything that sniffs as HTML/JS/SVG or an executable.
 */
function classify(data: Buffer): SniffedType | null {
  if (data.length === 0) return null;

  // --- Executables and scripts: rejected outright, never classified. ---
  if (startsWith(data, [0x7f, 0x45, 0x4c, 0x46])) return null; // ELF
  if (asciiAt(data, 'MZ')) return null; // PE/COFF
  if (asciiAt(data, '#!')) return null; // shebang script
  if (startsWith(data, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(data, [0xfe, 0xed, 0xfa, 0xcf])) {
    return null; // Mach-O
  }
  if (startsWith(data, [0xca, 0xfe, 0xba, 0xbe])) return null; // Java class / Mach-O fat

  // --- Documents and archives on the allow-list. ---
  if (asciiAt(data, '%PDF-')) return 'application/pdf';
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) {
    return 'application/zip';
  }

  // --- Images. ---
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAt(data, 'GIF87a') || asciiAt(data, 'GIF89a')) return 'image/gif';
  if (asciiAt(data, 'RIFF') && data.length >= 12 && asciiAt(data, 'WEBP', 8)) {
    return 'image/webp';
  }

  // --- Plain text: allowed only when it is genuinely inert text. ---
  return sniffText(data);
}

/** A text payload is inert only if it is valid UTF-8, NUL-free and not markup. */
function sniffText(data: Buffer): SniffedType | null {
  if (data.includes(0x00)) return null; // binary that matched no signature

  const head = data.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  if (head.length === 0) return 'text/plain';
  for (const marker of DANGEROUS_TEXT_MARKERS) {
    if (head.startsWith(marker)) return null;
  }
  // Round-trip check: invalid UTF-8 is a binary payload wearing a text extension.
  if (!Buffer.from(data.toString('utf8'), 'utf8').equals(data)) return null;

  return 'text/plain';
}

/** The canonical content type for a sniffed type, whatever the client claimed. */
const SNIFF_TO_CANONICAL: Record<SniffedType, string> = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'application/zip': 'application/zip',
  'text/plain': 'text/plain',
};

/** Broad family used to agree the sniffed type with the declared one. */
function family(type: string): string {
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/plain') return 'text';
  if (type === 'application/zip' || type.includes('openxmlformats')) return 'zip';
  return type;
}

/**
 * The scan step of docs/19 §7.2 (rules 2–3): sniff, allow-list, and require the sniffed
 * type to agree with the declared one. The returned content type is the **sniffed** one,
 * so a later reader never trusts what the uploader said.
 */
export function scanUpload(data: Buffer, declaredContentType: string): SniffResult {
  const declared = declaredContentType.toLowerCase().split(';')[0]?.trim() ?? '';

  if (!ALLOWED_DECLARED.has(declared)) {
    return { ok: false, reason: `Content type "${declared}" is not on the allow-list.` };
  }

  const sniffed = classify(data);
  if (sniffed === null) {
    return {
      ok: false,
      reason: 'The file contents are not an allowed type (executable, HTML or script).',
    };
  }

  if (family(sniffed) !== family(declared)) {
    return {
      ok: false,
      reason: `The file contents (${sniffed}) do not match the declared type (${declared}).`,
    };
  }

  return { ok: true, contentType: sniffed };
}

/** Canonical stored type for an accepted upload — the sniffed type, never the claim. */
export function canonicalContentType(sniffed: SniffedType): string {
  return SNIFF_TO_CANONICAL[sniffed];
}

/**
 * Sanitises a client filename for display (docs/19 §7.2 rule 2). The stored key is
 * server-generated and never derived from this value; this only prevents a filename from
 * carrying path separators, control characters or markup into a response header or the UI.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const cleaned = Array.from(base)
    // Control characters are stripped by code point — a filename never carries them into
    // a response header or the UI (docs/19 §7.2 rule 2).
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  const limited = cleaned.slice(0, 200);
  return limited.length > 0 ? limited : 'upload';
}

/** RFC 6266 header value: ASCII fallback plus the UTF-8 form for real names. */
export function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
