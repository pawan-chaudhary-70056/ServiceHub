import { expect, type Page } from '@playwright/test';
import type { Credentials } from './actors';

/**
 * Shared journey helpers (docs/37 §7).
 *
 * Sign-in goes through the real form rather than injecting a session cookie. That is
 * deliberate: the journey's whole point is that the integration is the risk, and a
 * cookie-driven shortcut would skip the CSRF handshake, the cookie flags and the
 * post-login landing — the parts most likely to break.
 */

/** Signs in through the UI and waits until the authenticated shell has rendered. */
export async function signIn(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(credentials.email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Leaving the form is the server's answer, not the client's: the landing route renders
  // only after `POST /auth/login` set the session cookie and `GET /auth/me` confirmed it.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** Signs out through the UI, ending the session server-side. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/**
 * A title unique to this run.
 *
 * Journeys are parallel by default, and several of them create records in a shared
 * environment. A fixed title would make two runs find each other's records, which is the
 * classic source of a suite that passes alone and fails in CI (`docs/37` §9).
 */
export function uniqueTitle(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000)}`;
}

/**
 * A distinctive, searchable token drawn from a title.
 *
 * Short tokens are matched by exact reference only (`search.service.ts`), so the token is
 * long enough to be full-text matched and contains no character that the search terms
 * truncate.
 */
export function searchToken(title: string): string {
  return title.split(' ').slice(1).join(' ');
}
