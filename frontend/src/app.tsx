import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { queryClient } from './api/query-client';
import { AppShell } from './components/app-shell';
import { AuthProvider } from './components/auth-provider';
import { AppRoutes } from './routes';

/**
 * Application root (docs/14).
 *
 * Provider order matters: the query client is outside the router so that navigation
 * does not remount server-state caches — a remount on every route change would refetch
 * everything and make navigation feel slow for no reason.
 *
 * The SPA holds **no business rules**. It renders what the API returns, collects input,
 * and applies client-side validation for feedback only (docs/12, docs/03 §3). Anything
 * enforceable — permissions, state transitions, SLA arithmetic — is enforced on the
 * server, because the client is fully under the user's control.
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Identity sits inside the query provider (it reads sessions through it) and
            inside the router (the shell navigates on sign-out). */}
        <AuthProvider>
          <AppShell>
            <AppRoutes />
          </AppShell>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
