import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StatusGroup } from '@theone/shared';
import { AppShell } from '../components/AppShell';
import { KpiRow } from '../components/KpiRow';
import { WorkOrdersTable } from '../components/WorkOrdersTable';
import { getKpis, listWorkOrders } from '../api/client';
import { useDebounced } from '../hooks/useDebounced';

type Filter = 'all' | StatusGroup;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'closed', label: 'Closed' },
];

export function WorkOrdersPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);

  const listParams = useMemo(
    () => ({
      status_group: filter === 'all' ? undefined : filter,
      search: debouncedSearch || undefined,
      limit: 200,
    }),
    [filter, debouncedSearch],
  );

  const woQuery = useQuery({
    queryKey: ['work-orders', listParams],
    queryFn: () => listWorkOrders(listParams),
  });

  const kpiQuery = useQuery({ queryKey: ['kpis'], queryFn: getKpis });

  const items = woQuery.data?.items ?? [];
  const total = woQuery.data?.total;

  return (
    <AppShell total={total} search={search} onSearchChange={setSearch}>
      <div className="page-head">
        <h1 className="page-title">Work Orders</h1>
        <p className="page-sub">
          {total != null ? `${total} work order${total === 1 ? '' : 's'}` : 'Loading…'}
        </p>
      </div>

      <KpiRow kpis={kpiQuery.data} loading={kpiQuery.isLoading} />

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Filter by status group">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`seg-btn${filter === f.key ? ' is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <WorkOrdersTable
        items={items}
        loading={woQuery.isLoading}
        error={woQuery.isError ? 'Failed to load work orders. Is the API running on :5174?' : null}
      />
    </AppShell>
  );
}
