/// <reference types="vite/client" />

/**
 * The client's configuration surface.
 *
 * Every property here is PUBLIC: Vite substitutes these values into the bundle at build
 * time and the browser can read them. There is deliberately no slot for a secret — a
 * credential placed in a `VITE_` variable is a published credential (docs/35 §2).
 *
 * Secrets live on the backend and are injected at runtime.
 */
interface ImportMetaEnv {
  /** Base URL for API calls. `/api/v1` in development, served by the edge in production. */
  readonly VITE_API_BASE_URL?: string;
  /** Display name for the application shell. */
  readonly VITE_APP_NAME?: string;
  /**
   * Name of the readable CSRF cookie the server sets (`ADR-0001`). The SPA echoes its
   * value in `X-CSRF-Token`; the name is configurable so an environment can prefix its
   * cookies without a code change.
   */
  readonly VITE_CSRF_COOKIE_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
