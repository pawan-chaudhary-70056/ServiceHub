import { loadEnv, type Env } from './env';

/**
 * The single configuration object for the process.
 *
 * Loaded once at import time and frozen, so no module can mutate configuration and
 * produce behaviour that depends on import order. If the environment is invalid this
 * throws immediately — fail fast, at boot (docs/35 §2).
 */
export const config: Readonly<Env> = Object.freeze(loadEnv());

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
export const isTest = config.NODE_ENV === 'test';

/**
 * Fixed API base path (docs/11 §1: `/api/v1`). Versioning lives in the path, so a
 * breaking change adds a new path version. Change here and in the OpenAPI document
 * together.
 */
export const API_PREFIX = '/api/v1';

export type { Env };
