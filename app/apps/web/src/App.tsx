import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ThemeProvider } from './theme/ThemeProvider';
import { INTAKE_PERM_KEY } from '@theone/shared';
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
import { QuotePrintPage } from './pages/QuotePrintPage';
import { RequestPaymentPage } from './pages/RequestPaymentPage';
import { QuotesPage } from './pages/QuotesPage';
import { ContractsPage } from './pages/ContractsPage';
import { PulsePage } from './pages/PulsePage';
import { ReceivablesPage } from './pages/ReceivablesPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { IntakePage } from './pages/IntakePage';
import { INCOMING_ACCEPT_PERM } from './components/IncomingTabs';

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
  if (!can(perm, 'view')) return <Locked nav={nav} />;
  return <>{children}</>;
}

function Locked({ nav }: { nav: NavKey }) {
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

/** /incoming — one page, two doors. A manager (`approvals/intake`) lands on
    the acceptance queue; a person who may only type work orders in
    (`intake`) lands on the Drafts tab; anyone with both gets the tab strip
    (IncomingTabs) and starts on To accept. Neither: the locked screen. */
function IncomingRoute() {
  const { can } = useAuth();
  if (can(INCOMING_ACCEPT_PERM, 'view')) return <ApprovalsPage mode="intake" />;
  if (can(INTAKE_PERM_KEY, 'view')) return <Navigate to="/incoming/drafts" replace />;
  return <Locked nav="Incoming Work Orders" />;
}

/** The drafts lived at /intake before they joined Incoming Work Orders;
    bookmarks and audit links from then still land. */
function LegacyIntakeRedirect() {
  const { draftId } = useParams<{ draftId: string }>();
  return <Navigate to={draftId ? `/incoming/drafts/${encodeURIComponent(draftId)}` : '/incoming/drafts'} replace />;
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
              {/* 0048 — the quote as a document, laid out for the print dialog
                  (save as PDF). No AppShell: the page IS the paper. */}
              <Route
                path="/work-orders/:woNumber/quote/print"
                element={<RequireAuth><RequireCan perm="quotes" nav="Work Orders"><QuotePrintPage /></RequireCan></RequireAuth>}
              />
              <Route
                path="/work-orders/:woNumber/request-payment"
                element={<RequireAuth><RequireCan perm="payments" nav="Work Orders"><RequestPaymentPage /></RequireCan></RequireAuth>}
              />
              <Route
                path="/quotes"
                element={<RequireAuth><RequireCan perm="quotes" nav="Quotes"><QuotesPage /></RequireCan></RequireAuth>}
              />
              {/* 0046 — the rate cards quotes and invoices price against. */}
              <Route
                path="/contracts"
                element={<RequireAuth><RequireCan perm="contracts" nav="Contracts"><ContractsPage /></RequireCan></RequireAuth>}
              />
              {/* S5 — the Pulse: every open obligation, by how much clock is left. */}
              <Route path="/pulse" element={<RequireAuth><PulsePage /></RequireAuth>} />
              {/* AR — Receivables: the completion audit (Grey Flag queue) and the
                  invoicing pipeline it feeds. :tab is 'invoicing'; bare =/audit. */}
              <Route path="/receivables" element={<RequireAuth><ReceivablesPage /></RequireAuth>} />
              <Route path="/receivables/:tab" element={<RequireAuth><ReceivablesPage /></RequireAuth>} />
              {/* Payables queue — approve, reject, hand to Yoda, mark paid. */}
              <Route
                path="/payments"
                element={<RequireAuth><RequireCan perm="payments" nav="Payments"><PaymentsPage /></RequireCan></RequireAuth>}
              />
              {/* Incoming Work Orders — one page for everything on its way in.
                  Rule 7.1.1 (0036): new work orders waiting to be accepted and
                  assigned (the inbox page in its intake mode). Section 14
                  (0040): the Drafts tab — the OP Admin's staging list and the
                  manual entry form for one draft. /intake is where the drafts
                  used to live. */}
              <Route path="/incoming" element={<RequireAuth><IncomingRoute /></RequireAuth>} />
              <Route
                path="/incoming/drafts"
                element={<RequireAuth><RequireCan perm={INTAKE_PERM_KEY} nav="Incoming Work Orders"><IntakePage /></RequireCan></RequireAuth>}
              />
              <Route
                path="/incoming/drafts/:draftId"
                element={<RequireAuth><RequireCan perm={INTAKE_PERM_KEY} nav="Incoming Work Orders"><IntakePage /></RequireCan></RequireAuth>}
              />
              <Route path="/intake" element={<LegacyIntakeRedirect />} />
              <Route path="/intake/:draftId" element={<LegacyIntakeRedirect />} />
              {/* The manager's inbox — approval tasks raised by automations (0026). */}
              <Route
                path="/approvals"
                element={<RequireAuth><RequireCan perm="approvals" nav="Approvals"><ApprovalsPage /></RequireCan></RequireAuth>}
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
