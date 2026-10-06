import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
// The stylesheet lives in assets/ so `src/` keeps exactly the files the charter
// mandates (app.tsx, main.tsx) at its root — see charter §3.
import './assets/global.css';

/**
 * Browser entrypoint.
 *
 * `StrictMode` is deliberate: it double-invokes render and effects in development so
 * accidental side effects in render, or an effect that does not clean up, surface
 * during development rather than in production.
 */
const container = document.getElementById('root');

if (!container) {
  // A missing mount point means index.html and the bundle disagree. Failing loudly
  // beats rendering nothing and leaving a blank page to debug.
  throw new Error('Root element #root was not found in index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
