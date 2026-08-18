import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StatusGroup } from '@theone/shared';
import { AppShell } from '../components/AppShell';
import { KpiRow } from '../components/KpiRow';
import { WorkOrdersTable, worstFor } from '../components/WorkOrdersTable';
import { Icon } from '../components/Icon';
import { getKpis, listWorkOrders } from '../api/client';
import { useDebounced } from '../hooks/useDebounced';
import { useNow } from '../hooks/useNow';
import { useObligationIndex } from '../hooks/useObligations';
import { breachRank } from '../lib/obligations';

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
  const [byBreach, setByBreach] = useState(false);
  const debouncedSearch = useDebounced(search, 250);
  const now = useNow();

  const listParams = useMemo(
    () => ({
      status_group: filter === 'all' ? undefined : filter,
      search: debouncedSearch || undefined,
      limit: 200,
      sort: byBreach ? ('breach' as const) : undefined,
    }),
    [filter, debouncedSearch, byBreach],
  );

  const woQuery = useQuery({
    queryKey: ['work-orders', listParams],
    queryFn: () => listWorkOrders(listParams),
  });

  const kpiQuery = useQuery({ queryKey: ['kpis'], queryFn: getKpis });

  // S5 — the Clock column. `?sort=breach` is the server's ordering; the same
  // order is applied here so the toggle still bites when the rows arrive
  // unsorted (or without `worst_obligation` at all).
  const { worstByWo } = useObligationIndex();

  const items = useMemo(() => {
    const rows = woQuery.data?.items ?? [];
    if (!byBreach) return rows;
    return [...rows].sort(
      (a, b) => breachRank(worstFor(b, worstByWo), now) - breachRank(worstFor(a, worstByWo), now),
    );
  }, [woQuery.data, byBreach, worstByWo, now]);

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

        <div className="seg" role="group" aria-label="Row order">
          <button
            type="button"
            className={`seg-btn${byBreach ? ' is-on' : ''}`}
            aria-pressed={byBreach}
            title="Order by the worst obligation on each work order"
            onClick={() => setByBreach((v) => !v)}
          >
            <Icon name="alert" size={12} />
            Sort by breach
          </button>
        </div>
      </div>

      <WorkOrdersTable
        items={items}
        obligationIndex={worstByWo}
        loading={woQuery.isLoading}
        error={woQuery.isError ? 'Failed to load work orders. Is the API running on :5174?' : null}
      />
    </AppShell>
  );
}
