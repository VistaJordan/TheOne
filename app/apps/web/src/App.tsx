import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ThemeProvider } from './theme/ThemeProvider';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { AppShell, type NavKey } from './components/AppShell';
import { Icon } from './components/Icon';
import { SignInPage } from './pages/SignInPage';
import { AdminUsersPage, AdminRolesPage } from './pages/admin/AdminUsersPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import {
  AdminSettingsPage,
  AdminAutomationsPage,
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

/**
 * 0015 · a page behind a section permission. Locked-with-a-reason rather than
 * a redirect, so a shared link explains itself. The API refuses the data
 * regardless; this only spares the person an empty, erroring screen.
 */
function RequireCan({
  perm,
  nav,
  children,
}: {
  perm: string;
  nav: NavKey;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(perm, 'view')) {
    return (
      <AppShell active={nav}>
        <div className="wo-state">
          <Icon name="lock" size={22} />
          <b>This section is not available to you</b>
          <span>Your role does not include it. Ask a super admin if you need access.</span>
        </div>
      </AppShell>
    );
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

              <Route
                path="/dashboard"
                element={<RequireAuth><RequireCan perm="dashboard" nav="Dashboard"><DashboardPage /></RequireCan></RequireAuth>}
              />
              <Route
                path="/"
                element={<RequireAuth><RequireCan perm="work_orders" nav="Work Orders"><WorkOrdersPage /></RequireCan></RequireAuth>}
              />
              {/* S2 — WO detail. Addressed by wo_number; the API resolves either
                  a uuid or a WO number on /api/work-orders/:id. */}
              <Route
                path="/work-orders/:woNumber"
                element={<RequireAuth><RequireCan perm="work_orders" nav="Work Orders"><WorkOrderDetailPage /></RequireCan></RequireAuth>}
              />
              {/* S4 — both screens hang off the WO, which is also how the API
                  addresses them (task_id is the key, never a quote id). */}
              <Route
                path="/work-orders/:woNumber/quote"
                element={<RequireAuth><RequireCan perm="quotes" nav="Work Orders"><QuoteBuilderPage /></RequireCan></RequireAuth>}
              />
              <Route
                path="/work-orders/:woNumber/request-payment"
                element={<RequireAuth><RequireCan perm="payments" nav="Work Orders"><RequestPaymentPage /></RequireCan></RequireAuth>}
              />
              <Route
                path="/quotes"
                element={<RequireAuth><RequireCan perm="quotes" nav="Quotes"><QuotesPage /></RequireCan></RequireAuth>}
              />
              {/* S5 — Admin Studio. Each section is its own route so the rail
                  can deep-link and the browser's back button works; AdminShell
                  gates every one of them on super admin. */}
              <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
              <Route path="/admin/users" element={<RequireAuth><AdminUsersPage /></RequireAuth>} />
              <Route path="/admin/roles" element={<RequireAuth><AdminRolesPage /></RequireAuth>} />
              <Route path="/admin/settings" element={<RequireAuth><AdminSettingsPage /></RequireAuth>} />
              <Route path="/admin/automations" element={<RequireAuth><AdminAutomationsPage /></RequireAuth>} />
              {/* The status editor that lived here moved into Custom fields. */}
              <Route path="/admin/workflows" element={<Navigate to="/admin/automations" replace />} />
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
