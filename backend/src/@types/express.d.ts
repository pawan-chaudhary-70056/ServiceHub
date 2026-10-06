/**
 * Request context augmentation.
 *
 * `correlationId` threads a request through every log line, audit entry and error
 * response so a support ticket can be resolved without guessing (docs/34 §3.4).
 *
 * `actor` is populated by the authentication middleware (`ADR-0001`: server-side
 * sessions). It is deliberately shaped as an identity + permission set, not as a
 * session or a token, so the mechanism does not leak into every service (docs/06,
 * docs/07).
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id for logs, audit and error responses. */
      correlationId?: string;
      /** Authenticated caller, if any. Absent on public routes. */
      actor?: {
        userId: string;
        /** Tenant of the caller; null for a platform operator (ADR-0012). */
        organizationId: string | null;
        isActive: boolean;
        /** Permission keys granted to the caller (docs/07). */
        permissions: ReadonlySet<string>;
      };
      /** The session backing the current request (set by `authenticate`). */
      session?: {
        id: string;
        /** SHA-256 digest of the CSRF token; compared on state-changing requests. */
        csrfSecretHash: string | null;
      };
    }
  }
}

export {};
