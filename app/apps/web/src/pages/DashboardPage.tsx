import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WoFilterSet } from '@theone/shared';
import { AppShell } from '../components/AppShell';
import { KpiRow } from '../components/KpiRow';
import { getKpis, listWorkOrders } from '../api/client';
import { filterUrl } from '../lib/woView';
import { VISIT_TYPE_FIELD_KEY } from '../lib/woFieldSections';

/** The at-a-glance page, in two views: Needs Attention (the default — the
    work-order hygiene problems worth fixing today, each card a link into the
    list pre-filtered to the offending rows) and the Main Dashboard (the four
    KPI cards). The KPIs live here rather than on the Work Orders list — that
    page is a working table, this one is the summary. */

type DashTab = 'attention' | 'main';

/** The rows behind the "Visit Type not set" card — also the filter its click
    hands to the list, so the card and the landing page can never disagree. */
const VISIT_TYPE_UNSET: WoFilterSet = {
  match: 'all',
  rules: [{ field: VISIT_TYPE_FIELD_KEY, op: 'is_not_set' }],
};

export function DashboardPage() {
  const [tab, setTab] = useState<DashTab>('attention');

  const kpiQuery = useQuery({ queryKey: ['kpis'], queryFn: getKpis });
  // Only for the sidebar's Work Orders badge, so the nav reads the same here as
  // it does on the list itself. One row is enough — we want `total`, not items.
  const countQuery = useQuery({
    queryKey: ['work-orders', { limit: 1 }],
    queryFn: () => listWorkOrders({ limit: 1 }),
  });
  // Each attention card is the same list query its click opens, at limit 1 —
  // only `total` is read.
  const visitTypeQuery = useQuery({
    queryKey: ['work-orders', { attention: 'visit-type' }],
    queryFn: () => listWorkOrders({ filters: VISIT_TYPE_UNSET, limit: 1 }),
  });
  const visitTypeCount = visitTypeQuery.data?.total;

  return (
    <AppShell active="Dashboard" total={countQuery.data?.total}>
      <div className="seg dash-tabs" role="group" aria-label="Dashboard pages">
        <button
          type="button"
          className={`seg-btn${tab === 'attention' ? ' is-on' : ''}`}
          aria-pressed={tab === 'attention'}
          onClick={() => setTab('attention')}
        >
          Needs Attention
        </button>
        <button
          type="button"
          className={`seg-btn${tab === 'main' ? ' is-on' : ''}`}
          aria-pressed={tab === 'main'}
          onClick={() => setTab('main')}
        >
          Main Dashboard
        </button>
      </div>

      {tab === 'attention' ? (
        <div className="attn-row">
          <AttentionCard
            label="Visit Type not set"
            count={visitTypeQuery.isError ? null : visitTypeCount}
            loading={visitTypeQuery.isLoading}
            to={filterUrl(VISIT_TYPE_UNSET)}
            allClearNote="Every work order has a visit type"
          />
        </div>
      ) : (
        <KpiRow kpis={kpiQuery.data} loading={kpiQuery.isLoading} />
      )}
    </AppShell>
  );
}

/** One Needs Attention card: a count of work orders in a bad state, linking to
    the list pre-filtered to exactly those rows. `count` null = the query
    failed (most likely the field behind it is not in this DB's catalogue). */
function AttentionCard({
  label,
  count,
  loading,
  to,
  allClearNote,
}: {
  label: string;
  count: number | null | undefined;
  loading: boolean;
  to: string;
  allClearNote: string;
}) {
  const hot = typeof count === 'number' && count > 0;
  return (
    <Link className={`kpi attn${hot ? ' hot' : ''}`} to={to}>
      <div className="kl">{label}</div>
      <div className="kv">{loading ? '—' : count === null ? '?' : String(count ?? 0)}</div>
      {/* A hot card explains itself — the count is the message and the card is
          the link. Only the edge states need a caption. */}
      {!loading && (count === null || !hot) && (
        <div className="km">
          {count === null
            ? 'Could not count these — is the Visit Type field in the catalogue?'
            : allClearNote}
        </div>
      )}
    </Link>
  );
}
