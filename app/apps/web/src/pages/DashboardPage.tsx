import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../components/AppShell';
import { KpiRow } from '../components/KpiRow';
import { getKpis, listWorkOrders } from '../api/client';

/** The at-a-glance page. The four KPI cards live here rather than on the Work
    Orders list — that page is a working table, this one is the summary. */
export function DashboardPage() {
  const kpiQuery = useQuery({ queryKey: ['kpis'], queryFn: getKpis });
  // Only for the sidebar's Work Orders badge, so the nav reads the same here as
  // it does on the list itself. One row is enough — we want `total`, not items.
  const countQuery = useQuery({
    queryKey: ['work-orders', { limit: 1 }],
    queryFn: () => listWorkOrders({ limit: 1 }),
  });

  return (
    <AppShell active="Dashboard" total={countQuery.data?.total}>
      <KpiRow kpis={kpiQuery.data} loading={kpiQuery.isLoading} />
    </AppShell>
  );
}
