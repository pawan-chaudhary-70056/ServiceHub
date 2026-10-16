import { config } from '../config';

/**
 * The antivirus scanner adapter (`docs/19` §7.2 step 7).
 *
 * The upload pipeline's step 7 is a **scan**, and rule 1 of the same section is absolute:
 * "files are not retrievable until scanned; a quarantined file is never served". That makes
 * the scanner a gate rather than a check, so its failure modes have to be designed and not
 * discovered:
 *
 *   - **Unconfigured** (`ANTIVIRUS_URL` unset) — there is no scanner to ask. The content sniff
 *     remains the only gate and the upload is promoted on the request path, exactly as before
 *     this module existed. Development and the test suite depend on that, and pretending
 *     otherwise would leave every attachment unretrievable.
 *   - **Configured but unreachable** — the verdict is `UNAVAILABLE`, never `CLEAN`. The
 *     difference matters: a scanner that is down must not be mistaken for a scanner that
 *     approved the file, or an outage silently becomes a bypass. The scan worker leaves the
 *     row `PENDING` in that case, so the file stays unservable until the scanner answers.
 *
 * The wire contract is the widely deployed clamd HTTP contract: `POST` the raw bytes, `200`
 * means clean, `406` means the scanner identified malware. Anything else is `UNAVAILABLE`.
 * The bytes are posted, not a path, because the backend holds no shared filesystem
 * (`docs/19` §7.1) — a path-based scanner cannot work across N stateless instances.
 *
 * Like every adapter here, it **never throws**: a transport failure is a domain-level
 * verdict, because a thrown exception out of an external call is how an integration failure
 * reaches the request path (`docs/32` §1, §9).
 */

export type AntivirusVerdictValue = 'CLEAN' | 'INFECTED' | 'UNAVAILABLE';

export interface AntivirusVerdict {
  verdict: AntivirusVerdictValue;
  /** Domain-level reason, safe to log and to show an operator. Never a raw scanner body. */
  reason?: string;
}

export interface AntivirusAdapter {
  /** `true` when a scanner is configured; an unconfigured adapter is a no-op, not a failure. */
  readonly configured: boolean;
  scan(input: { data: Buffer; contentType: string }): Promise<AntivirusVerdict>;
}

/** Clean, on the clamd HTTP contract. */
const CLEAN_STATUS = 200;
/** Malware found, on the clamd HTTP contract. */
const INFECTED_STATUS = 406;

/**
 * No scanner configured: an explicit `UNAVAILABLE`, never a silent `CLEAN`.
 *
 * The upload path does not call this adapter at all when `configured` is false — it keeps
 * today's promote-on-upload behaviour. The verdict exists for the scan worker and the admin
 * connectivity test, both of which must be able to say "not configured" out loud.
 */
export const unsupportedAntivirusAdapter: AntivirusAdapter = {
  configured: false,
  async scan(): Promise<AntivirusVerdict> {
    return {
      verdict: 'UNAVAILABLE',
      reason: 'No antivirus scanner is configured (ANTIVIRUS_URL is unset).',
    };
  },
};

/**
 * A clamd-compatible HTTP scanner at `url`.
 *
 * The URL is a parameter rather than read from `config` inside the call, so the adapter is
 * constructible against a stub in a test without mutating frozen configuration — and so the
 * `unconfigured` case cannot be reached by accident through a missing environment value.
 */
export function createClamavHttpAdapter(
  url: string,
  timeoutMs: number = config.ANTIVIRUS_TIMEOUT_MS,
): AntivirusAdapter {
  return {
    configured: true,
    async scan({ data, contentType }): Promise<AntivirusVerdict> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': contentType || 'application/octet-stream' },
          body: new Uint8Array(data),
          redirect: 'manual',
          signal: controller.signal,
        });

        if (response.status === CLEAN_STATUS) return { verdict: 'CLEAN' };
        if (response.status === INFECTED_STATUS) {
          return {
            verdict: 'INFECTED',
            reason: 'The scanner identified the file as malware.',
          };
        }
        if (response.status >= 500) {
          return {
            verdict: 'UNAVAILABLE',
            reason: `The scanner failed to scan the file (HTTP ${response.status}).`,
          };
        }
        return {
          verdict: 'UNAVAILABLE',
          reason: `The scanner returned an unexpected status (HTTP ${response.status}).`,
        };
      } catch (error) {
        const reason =
          error instanceof Error && error.name === 'AbortError'
            ? 'The scanner did not respond within the timeout.'
            : 'The scanner could not be reached.';
        return { verdict: 'UNAVAILABLE', reason };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** The configured scanner, or the explicit no-op when none is set. */
export function antivirusAdapter(): AntivirusAdapter {
  const url = config.ANTIVIRUS_URL;
  return url ? createClamavHttpAdapter(url) : unsupportedAntivirusAdapter;
}

/** Whether the asynchronous scan step is in force. Read by the upload path and the worker. */
export function isAntivirusConfigured(): boolean {
  return antivirusAdapter().configured;
}
