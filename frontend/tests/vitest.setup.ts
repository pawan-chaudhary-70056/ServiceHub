import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Component-test setup.
 *
 * `@testing-library/jest-dom/vitest` registers the DOM matchers (toBeInTheDocument,
 * toHaveAccessibleName, …). The accessibility matchers matter here: `docs/16` makes
 * keyboard reachability and labelling requirements, and a test asserting an accessible
 * name is how those requirements stay true instead of being a review convention.
 *
 * Unmounting between tests prevents state leaking across cases — a shared DOM is the
 * most common source of order-dependent, flaky frontend tests (docs/37 §9).
 */
afterEach(() => {
  cleanup();
});
