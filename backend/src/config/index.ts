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
 * Process tier (`docs/03` §6, `docs/34` §4).
 *
 * Kept as pure predicates so the decision is testable without starting a process: the rule
 * "the worker does not serve HTTP, and the API does not own the schedulers" is a property of
 * the role, not of the entrypoint that reads it.
 */
export type ProcessRole = Env['PROCESS_ROLE'];

export const processRole: ProcessRole = config.PROCESS_ROLE;

/** Whether this role exposes the HTTP API. */
export function servesHttp(role: ProcessRole = processRole): boolean {
  return role === 'all' || role === 'api';
}

/** Whether this role runs the background schedulers. */
export function runsSchedulers(role: ProcessRole = processRole): boolean {
  return role === 'all' || role === 'worker';
}

/**
 * Fixed API base path (docs/11 §1: `/api/v1`). Versioning lives in the path, so a
 * breaking change adds a new path version. Change here and in the OpenAPI document
 * together.
 */
export const API_PREFIX = '/api/v1';

export type { Env };
