import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  boundaryOf,
  parseMultipartBody,
  parseMultipartRequest,
  readBodyWithCap,
  type UploadSource,
} from '../src/helpers/multipart';
import { contentDisposition, sanitizeFilename, scanUpload } from '../src/helpers/file-sniff';

/**
 * Upload-pipeline unit tests (docs/19 §7.2, docs/37 §3).
 *
 * These are the pure pieces of the file path — the bounded reader, the multipart parser
 * and the content sniff — tested without a database so the security properties are
 * pinned directly rather than inferred through an endpoint:
 *
 *   - the size cap is enforced **while reading**, so a request that under-reports its
 *     length cannot stream past the limit (rule 4);
 *   - sniffing, not the filename or header, decides the type (rules 2–3);
 *   - HTML, script, SVG and executables are never accepted (§7.4).
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function source(headers: Record<string, string>, chunks: Buffer[]): UploadSource {
  const stream = Readable.from(chunks) as unknown as UploadSource;
  stream.headers = headers;
  return stream;
}

function multipartBody(
  parts: Array<{ name: string; value: Buffer; filename?: string; type?: string }>,
): Buffer {
  const boundary = '----testboundary42';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n`;
    chunks.push(Buffer.from(disposition));
    if (part.filename) {
      chunks.push(Buffer.from(`Content-Type: ${part.type ?? 'application/octet-stream'}\r\n`));
    }
    chunks.push(Buffer.from('\r\n'));
    chunks.push(part.value);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe('bounded body reader', () => {
  it('rejects a declared Content-Length above the cap before reading the body', async () => {
    const stream = source({ 'content-length': '999999' }, [PNG]);
    await expect(readBodyWithCap(stream, 100)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('rejects a stream that exceeds the cap mid-flight (lying Content-Length)', async () => {
    const stream = source({}, [Buffer.alloc(60), Buffer.alloc(60)]);
    await expect(readBodyWithCap(stream, 100)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('returns the exact bytes when the body fits', async () => {
    const stream = source({}, [Buffer.from('ab'), Buffer.from('cd')]);
    await expect(readBodyWithCap(stream, 100)).resolves.toEqual(Buffer.from('abcd'));
  });
});

describe('multipart parsing', () => {
  it('extracts fields and files with their bytes intact', async () => {
    const body = multipartBody([
      { name: 'entityType', value: Buffer.from('ServiceRequest') },
      { name: 'file', value: PNG, filename: 'photo.png', type: 'image/png' },
    ]);
    const payload = await parseMultipartRequest(
      source({ 'content-type': 'multipart/form-data; boundary=----testboundary42' }, [body]),
      { maxTotalBytes: 10_000, maxFiles: 1 },
    );
    expect(payload.fields.entityType).toBe('ServiceRequest');
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]?.filename).toBe('photo.png');
    expect(payload.files[0]?.contentType).toBe('image/png');
    expect(payload.files[0]?.data.equals(PNG)).toBe(true);
  });

  it('rejects a non-multipart content type and a body with no boundary', () => {
    expect(() => boundaryOf('application/json')).toThrowError(/multipart/i);
    expect(() => boundaryOf('multipart/form-data')).toThrowError(/boundary/i);
    expect(() =>
      parseMultipartBody(Buffer.from('nothing here'), 'boundary', { maxFiles: 1 }),
    ).toThrowError();
  });

  it('rejects an upload with no file part and an unterminated part', async () => {
    const noFile = multipartBody([{ name: 'entityType', value: Buffer.from('ServiceRequest') }]);
    await expect(
      parseMultipartRequest(
        source({ 'content-type': 'multipart/form-data; boundary=----testboundary42' }, [noFile]),
        { maxTotalBytes: 10_000, maxFiles: 1 },
      ),
    ).rejects.toThrowError(/no file part/i);

    const unterminated = Buffer.from(
      '--b\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\nbytes',
    );
    expect(() => parseMultipartBody(unterminated, 'b', { maxFiles: 1 })).toThrowError();
  });

  it('enforces the file-count limit', () => {
    const body = multipartBody([
      { name: 'file', value: PNG, filename: 'a.png', type: 'image/png' },
      { name: 'file', value: PNG, filename: 'b.png', type: 'image/png' },
    ]);
    expect(() => parseMultipartBody(body, '----testboundary42', { maxFiles: 1 })).toThrowError(
      /At most 1/,
    );
  });
});

describe('content sniffing (docs/19 §7.2 rules 2–3)', () => {
  it('accepts an allow-listed payload and stores the sniffed type', () => {
    const png = scanUpload(PNG, 'image/png');
    expect(png).toEqual({ ok: true, contentType: 'image/png' });

    const pdf = scanUpload(Buffer.from('%PDF-1.7\n%âãÏÓ'), 'application/pdf');
    expect(pdf).toEqual({ ok: true, contentType: 'application/pdf' });

    const zip = scanUpload(
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]),
      'application/zip',
    );
    expect(zip.ok).toBe(true);

    const text = scanUpload(Buffer.from('A plain note about the outage.\n'), 'text/plain');
    expect(text).toEqual({ ok: true, contentType: 'text/plain' });
  });

  it('rejects a .pdf containing HTML (extension and header spoofing)', () => {
    const html = scanUpload(
      Buffer.from('<!DOCTYPE html><html><body>hi</body></html>'),
      'application/pdf',
    );
    expect(html.ok).toBe(false);
  });

  it('rejects executables, scripts and SVG whatever they claim to be', () => {
    const elf = scanUpload(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), 'text/plain');
    expect(elf.ok).toBe(false);

    const windows = scanUpload(
      Buffer.from('MZ\x90\x00This program cannot be run'),
      'application/pdf',
    );
    expect(windows.ok).toBe(false);

    const script = scanUpload(Buffer.from('#!/bin/sh\nrm -rf /\n'), 'text/plain');
    expect(script.ok).toBe(false);

    const svg = scanUpload(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'image/png',
    );
    expect(svg.ok).toBe(false);
  });

  it('rejects an HTML content type outright — it is never on the allow-list', () => {
    expect(scanUpload(Buffer.from('anything'), 'text/html').ok).toBe(false);
    expect(scanUpload(PNG, 'image/svg+xml').ok).toBe(false);
  });

  it('rejects a type that does not match the sniffed contents', () => {
    expect(scanUpload(PNG, 'application/pdf').ok).toBe(false);
    expect(scanUpload(Buffer.from('%PDF-1.4'), 'image/png').ok).toBe(false);
  });
});

describe('filename handling (docs/19 §7.2 rule 2)', () => {
  it('strips path components, control characters and header-hostile characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\uploads\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('a\u0000b<c>d|e".txt')).toBe('ab_c_d_e_.txt');
    expect(sanitizeFilename('   ')).toBe('upload');
    expect(sanitizeFilename('quarterly report.pdf')).toBe('quarterly report.pdf');
  });

  it('builds a disposition that is ASCII-safe and RFC 5987 encoded', () => {
    expect(contentDisposition('report.pdf', false)).toBe(
      'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf',
    );
    expect(contentDisposition('résumé.pdf', true).startsWith('inline;')).toBe(true);
    expect(contentDisposition('résumé.pdf', true)).toContain('filename="r_sum_.pdf"');
  });
});
