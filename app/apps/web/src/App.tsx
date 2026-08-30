import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ThemeProvider } from './theme/ThemeProvider';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { SignInPage } from './pages/SignInPage';
import { AdminUsersPage, AdminRolesPage } from './pages/admin/AdminUsersPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import {
  AdminSettingsPage,
  AdminWorkflowsPage,
  AdminFieldsPage,
  AdminThemesPage,
  AdminTrashPage,
} from './pages/admin/AdminSections';
import { DashboardPage } from './pages/DashboardPage';
import { WorkOrdersPage } from './pages/WorkOrdersPage';
import { WorkOrderDetailPage } from './pages/WorkOrderDetailPage';
import { QuoteBuilderPage } from './pages/QuoteBuilderPage';
import { RequestPaymentPage } from './pages/RequestPaymentPage';
import { QuotesPage } from './pages/QuotesPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

/**
 * S5 · nothing renders until the session is known.
 *
 * The blank hold while `/auth/me` is in flight is deliberate: rendering the app
 * optimistically and swapping to the sign-in screen a moment later flashes real
 * work-order data at somebody who may not be entitled to it.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, authenticated } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="boot" role="status" aria-live="polite">
        <span className="boot-dot" aria-hidden="true" />
        Checking your session…
      </div>
    );
  }

  if (!authenticated) {
    // Carry the intended destination so a deep link survives the round trip.
    const to = `/sign-in?redirect_to=${encodeURIComponent(location.pathname + location.search)}`;
    return <Navigate to={to} replace />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              {/* The only route outside the guard. */}
              <Route path="/sign-in" element={<SignInPage />} />

              <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
              <Route path="/" element={<RequireAuth><WorkOrdersPage /></RequireAuth>} />
              {/* S2 — WO detail. Addressed by wo_number; the API resolves either
                  a uuid or a WO number on /api/work-orders/:id. */}
              <Route
                path="/work-orders/:woNumber"
                element={<RequireAuth><WorkOrderDetailPage /></RequireAuth>}
              />
              {/* S4 — both screens hang off the WO, which is also how the API
                  addresses them (task_id is the key, never a quote id). */}
              <Route
                path="/work-orders/:woNumber/quote"
                element={<RequireAuth><QuoteBuilderPage /></RequireAuth>}
              />
              <Route
                path="/work-orders/:woNumber/request-payment"
                element={<RequireAuth><RequestPaymentPage /></RequireAuth>}
              />
              <Route path="/quotes" element={<RequireAuth><QuotesPage /></RequireAuth>} />
              {/* S5 — Admin Studio. Each section is its own route so the rail
                  can deep-link and the browser's back button works; AdminShell
                  gates every one of them on super admin. */}
              <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
              <Route path="/admin/users" element={<RequireAuth><AdminUsersPage /></RequireAuth>} />
              <Route path="/admin/roles" element={<RequireAuth><AdminRolesPage /></RequireAuth>} />
              <Route path="/admin/settings" element={<RequireAuth><AdminSettingsPage /></RequireAuth>} />
              <Route path="/admin/workflows" element={<RequireAuth><AdminWorkflowsPage /></RequireAuth>} />
              <Route path="/admin/fields" element={<RequireAuth><AdminFieldsPage /></RequireAuth>} />
              <Route path="/admin/themes" element={<RequireAuth><AdminThemesPage /></RequireAuth>} />
              <Route path="/admin/audit" element={<RequireAuth><AdminAuditPage /></RequireAuth>} />
              <Route path="/admin/trash" element={<RequireAuth><AdminTrashPage /></RequireAuth>} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
