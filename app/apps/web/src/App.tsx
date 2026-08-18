import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { WorkOrdersPage } from './pages/WorkOrdersPage';
import { WorkOrderDetailPage } from './pages/WorkOrderDetailPage';
import { QuoteBuilderPage } from './pages/QuoteBuilderPage';
import { RequestPaymentPage } from './pages/RequestPaymentPage';
import { QuotesPage } from './pages/QuotesPage';
import { PulsePage } from './pages/PulsePage';
import { ReceivablesPage } from './pages/ReceivablesPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<WorkOrdersPage />} />
            {/* S2 — WO detail. Addressed by wo_number; the API resolves either
                a uuid or a WO number on /api/work-orders/:id. */}
            <Route path="/work-orders/:woNumber" element={<WorkOrderDetailPage />} />
            {/* S4 — both screens hang off the WO, which is also how the API
                addresses them (task_id is the key, never a quote id). */}
            <Route path="/work-orders/:woNumber/quote" element={<QuoteBuilderPage />} />
            <Route path="/work-orders/:woNumber/request-payment" element={<RequestPaymentPage />} />
            <Route path="/quotes" element={<QuotesPage />} />
            {/* S5 — the Pulse: every open obligation, by how much clock is left. */}
            <Route path="/pulse" element={<PulsePage />} />
            {/* AR — Receivables: the completion audit (Grey Flag queue) and the
                invoicing pipeline it feeds. :tab is 'invoicing'; bare =/audit. */}
            <Route path="/receivables" element={<ReceivablesPage />} />
            <Route path="/receivables/:tab" element={<ReceivablesPage />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
