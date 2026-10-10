import type { Readable } from 'node:stream';
import { AppError, MalformedRequestError } from '../utils/errors';

/**
 * A bounded `multipart/form-data` reader for the upload pipeline (docs/19 §7.2).
 *
 * This is deliberately **not** `express.json()`: uploads are a separate path with their
 * own size cap, content sniffing and authorization (docs/19 §7.2, app.ts §4). Writing the
 * parser here keeps the dependency surface unchanged and, more importantly, lets the cap
 * be enforced **while reading** — rule 4 requires the limit to be checked on the stream,
 * so a request that lies about `Content-Length` is rejected the moment the bytes exceed
 * the cap rather than after the whole body has been buffered.
 *
 * Scope: RFC 7578 basics — a single boundary, `name` and `filename` parameters, CRLF
 * line endings. It is intentionally strict: anything it cannot parse unambiguously is a
 * malformed request (400), not something to guess at (docs/12 §9).
 *
 * The source is typed structurally rather than as `express.Request`, because a helper is
 * a leaf module and must not depend on the HTTP framework (docs/03 §4).
 */

/** The subset of an upload request this module needs: headers plus a byte stream. */
export interface UploadSource extends Readable {
  headers: Record<string, string | string[] | undefined>;
}

export interface MultipartFile {
  /** Form field name (`file`). */
  field: string;
  /** Raw client filename — metadata only; sanitised before display (docs/19 §7.2 r2). */
  filename: string;
  /** Client-declared part content type — advisory; sniffing decides (docs/19 §7.2 r2). */
  contentType: string;
  data: Buffer;
}

export interface MultipartPayload {
  fields: Record<string, string>;
  files: MultipartFile[];
}

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

function headerValue(source: UploadSource, name: string): string | undefined {
  const value = source.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Reads the raw request body, aborting the moment `maxBytes` would be exceeded. */
export async function readBodyWithCap(source: UploadSource, maxBytes: number): Promise<Buffer> {
  const declared = Number(headerValue(source, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Size check *before* reading the body (docs/19 §7.2 rule 4).
    throw new AppError({
      code: 'PAYLOAD_TOO_LARGE',
      message: `The upload exceeds the ${maxBytes}-byte limit.`,
    });
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', fail);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      source.destroy();
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new AppError({
            code: 'PAYLOAD_TOO_LARGE',
            message: `The upload exceeds the ${maxBytes}-byte limit.`,
          }),
        );
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', fail);
  });
}

/** Extracts the boundary from a `multipart/form-data` content type. */
export function boundaryOf(contentType: string | undefined): string {
  if (!contentType || !contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new MalformedRequestError('Expected a multipart/form-data request body.');
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary) {
    throw new MalformedRequestError('The multipart boundary is missing.');
  }
  return boundary;
}

interface PartHeaders {
  filename: string | null;
  contentType: string;
  name: string | null;
}

function parsePartHeaders(raw: Buffer): PartHeaders {
  const text = raw.toString('latin1');
  let filename: string | null = null;
  let name: string | null = null;
  let contentType = 'application/octet-stream';

  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const header = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (header === 'content-type') {
      contentType = value.split(';')[0]?.trim().toLowerCase() ?? contentType;
    } else if (header === 'content-disposition') {
      // Only the parameters matter; the value (`form-data`) is ignored.
      const nameMatch = /(?:^|;)\s*name="([^"]*)"/i.exec(value);
      const plainNameMatch = /(?:^|;)\s*name=([^";]+)/i.exec(value);
      name = nameMatch?.[1] ?? plainNameMatch?.[1]?.trim() ?? null;

      const fileMatch = /(?:^|;)\s*filename="([^"]*)"/i.exec(value);
      const plainFileMatch = /(?:^|;)\s*filename=([^";]+)/i.exec(value);
      if (fileMatch?.[1] !== undefined) filename = fileMatch[1];
      else if (plainFileMatch?.[1] !== undefined) filename = plainFileMatch[1].trim();
    }
  }

  return { filename, contentType, name };
}

/**
 * Parses a buffered multipart body. Total size is already bounded by the reader, so the
 * scan here is linear and allocation is proportional to the body, never to a value a
 * client controls beyond that cap.
 */
export function parseMultipartBody(
  body: Buffer,
  boundary: string,
  limits: { maxFiles: number },
): MultipartPayload {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) {
    throw new MalformedRequestError('The multipart body contains no boundary.');
  }

  for (;;) {
    cursor += delimiter.length;
    // Closing delimiter: `--boundary--`.
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '--') {
      break;
    }
    // Each delimiter is followed by CRLF before the part headers.
    if (body.subarray(cursor, cursor + 2).equals(CRLF)) {
      cursor += 2;
    } else {
      throw new MalformedRequestError('The multipart body is malformed.');
    }

    const headerEnd = body.indexOf(DOUBLE_CRLF, cursor);
    if (headerEnd === -1) {
      throw new MalformedRequestError('A multipart part has no header section.');
    }
    const headers = parsePartHeaders(body.subarray(cursor, headerEnd));
    const contentStart = headerEnd + DOUBLE_CRLF.length;

    // The part ends at CRLF followed by the boundary delimiter.
    const next = body.indexOf(Buffer.concat([CRLF, delimiter]), contentStart);
    if (next === -1) {
      throw new MalformedRequestError('A multipart part is not terminated.');
    }
    const data = body.subarray(contentStart, next);

    if (headers.filename !== null) {
      if (files.length >= limits.maxFiles) {
        throw new AppError({
          code: 'VALIDATION_FAILED',
          message: `At most ${limits.maxFiles} file may be uploaded at once.`,
        });
      }
      files.push({
        field: headers.name ?? 'file',
        filename: headers.filename,
        contentType: headers.contentType,
        data: Buffer.from(data),
      });
    } else if (headers.name !== null) {
      fields[headers.name] = data.toString('utf8');
    }

    cursor = next + 2; // consume the CRLF that precedes the next delimiter
  }

  return { fields, files };
}

/** Read and parse an upload request in one bounded pass. */
export async function parseMultipartRequest(
  source: UploadSource,
  limits: { maxTotalBytes: number; maxFiles: number },
): Promise<MultipartPayload> {
  const boundary = boundaryOf(headerValue(source, 'content-type'));
  const body = await readBodyWithCap(source, limits.maxTotalBytes);
  const payload = parseMultipartBody(body, boundary, limits);

  if (payload.files.length === 0) {
    throw new MalformedRequestError('The request contains no file part.');
  }
  return payload;
}
