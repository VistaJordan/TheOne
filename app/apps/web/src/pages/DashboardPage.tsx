import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { dashboardPermKey, type WoFilterSet } from '@theone/shared';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { KpiRow } from '../components/KpiRow';
import { DashCards } from '../components/dash/DashCards';
import { DashboardBoard } from '../components/dash/DashboardBoard';
import {
  ApiRequestError,
  countWorkOrders,
  createDashboard,
  getKpis,
  listApprovals,
  listDashboards,
  listWorkOrders,
} from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { filterUrl } from '../lib/woView';
import { VISIT_TYPE_FIELD_KEY } from '../lib/woFieldSections';

/** The at-a-glance page, in two views: Needs Attention (the default — the
    work-order hygiene problems worth fixing today, each card a link into the
    list pre-filtered to the offending rows) and the Main Dashboard (the four
    KPI cards plus the user's own cards — components/dash/DashCards.tsx). The
    KPIs live here rather than on the Work Orders list — that page is a
    working table, this one is the summary. */

/** The two built-in views, plus (0042) one tab per dashboard record the
    viewer may open — those tabs carry the dashboard's id. */
type DashTab = 'attention' | 'main' | (string & {});

/** The rows behind the "No visit logged" card — also the filter its click
    hands to the list, so the card and the landing page can never disagree.
    'Visit Type' mirrors the latest visit (0021), so "not set" means no visit
    has been logged on the work order yet. */
const VISIT_TYPE_UNSET: WoFilterSet = {
  match: 'all',
  rules: [{ field: VISIT_TYPE_FIELD_KEY, op: 'is_not_set' }],
};

export function DashboardPage() {
  const { can } = useAuth();
  // 0050 · which of the two built-in pages this person opens is a tick under
  // Admin › Roles › Dashboard › Which dashboards, like every other dashboard.
  const canAttention = can(dashboardPermKey('attention'), 'view');
  const canMain = can(dashboardPermKey('main'), 'view');
  const [picked, setPicked] = useState<DashTab | null>(null);
  const [naming, setNaming] = useState(false);

  // 0042 · the shared dashboards. Failing to load them must not take the
  // built-in views down with it, so the query does not retry and the tabs
  // simply do not appear.
  const dashQuery = useQuery({ queryKey: ['dashboards'], queryFn: listDashboards, retry: 0 });
  const dashboards = dashQuery.data?.items ?? [];
  // The first page they may open, until they pick one.
  const tab: DashTab | null =
    picked ?? (canAttention ? 'attention' : canMain ? 'main' : (dashboards[0]?.id ?? null));
  const setTab = (t: DashTab) => setPicked(t);
  const current = dashboards.find((d) => d.id === tab);

  const kpiQuery = useQuery({
    queryKey: ['kpis', 'main'],
    queryFn: () => getKpis('main'),
    enabled: canMain && tab === 'main',
  });
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
    queryFn: () => countWorkOrders(VISIT_TYPE_UNSET, 'attention'),
    enabled: canAttention,
  });
  const visitTypeCount = visitTypeQuery.data?.total;

  // The inbox's open count (0026) — only asked for when this person may see
  // the inbox, so the card never shows a 403 as a mystery.
  const canSeeApprovals = can('approvals', 'view');
  // 0042 · building a dashboard is a create grant on the same path the
  // section is gated on.
  const canBuild = can('dashboard', 'create');
  const approvalsQuery = useQuery({
    queryKey: ['approvals'],
    queryFn: listApprovals,
    enabled: canSeeApprovals && canAttention,
    retry: 0,
  });
  const openApprovals = approvalsQuery.data?.counts.open;

  return (
    <AppShell active="Dashboard" total={countQuery.data?.total}>
      <div className="seg dash-tabs" role="group" aria-label="Dashboard pages">
        {canAttention && (
          <button
            type="button"
            className={`seg-btn${tab === 'attention' ? ' is-on' : ''}`}
            aria-pressed={tab === 'attention'}
            onClick={() => setTab('attention')}
          >
            Needs Attention
          </button>
        )}
        {canMain && (
          <button
            type="button"
            className={`seg-btn${tab === 'main' ? ' is-on' : ''}`}
            aria-pressed={tab === 'main'}
            onClick={() => setTab('main')}
          >
            Main Dashboard
          </button>
        )}
        {/* 0042 · the shared dashboards, in folder order. Everyone in a team
            opens the same one and sees their own work orders in it. */}
        {dashboards.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`seg-btn${tab === d.id ? ' is-on' : ''}`}
            aria-pressed={tab === d.id}
            onClick={() => setTab(d.id)}
            title={d.folder_name ? `${d.folder_name} · ${d.description ?? ''}` : (d.description ?? undefined)}
          >
            {d.name}
          </button>
        ))}
        {canBuild && (
          <button type="button" className="seg-btn is-add" onClick={() => setNaming(true)} title="Build a dashboard">
            +
          </button>
        )}
      </div>

      {tab === null ? (
        <p className="hint">
          {dashQuery.isLoading ? 'Loading dashboards…' : 'No dashboard has been shared with you yet.'}
        </p>
      ) : tab === 'attention' && canAttention ? (
        <div className="attn-row">
          <AttentionCard
            label="No visit logged"
            count={visitTypeQuery.isError ? null : visitTypeCount}
            loading={visitTypeQuery.isLoading}
            to={filterUrl(VISIT_TYPE_UNSET)}
            allClearNote="Every work order has a visit logged"
          />
          {canSeeApprovals && (
            <AttentionCard
              label="Awaiting approval"
              count={approvalsQuery.isError ? null : openApprovals}
              loading={approvalsQuery.isLoading}
              to="/approvals"
              allClearNote="Nothing is waiting for a decision"
              errorNote="Could not count the open approval tasks"
            />
          )}
        </div>
      ) : tab === 'main' && canMain ? (
        <>
          <KpiRow kpis={kpiQuery.data} loading={kpiQuery.isLoading} />
          {/* The build-your-own half: cards over any catalogue field, plus
              durations measured from the audit trail's change timestamps.
              These stay PERSONAL — 0042's dashboards are the shared ones. */}
          <DashCards />
        </>
      ) : current ? (
        <DashboardBoard dashboard={current} />
      ) : (
        <p className="hint">
          {dashQuery.isLoading ? 'Loading dashboards…' : 'That dashboard is no longer there.'}
        </p>
      )}

      {naming && (
        <NewDashboardDialog
          onClose={() => setNaming(false)}
          onCreated={(id) => {
            setNaming(false);
            setTab(id);
          }}
        />
      )}
    </AppShell>
  );
}

/** Name it, and it exists — private until its owner shares it. */
function NewDashboardDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createDashboard({ name: name.trim(), description: description.trim() || null }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['dashboards'] });
      onCreated(res.dashboard.id);
    },
    onError: (err: unknown) =>
      setError(err instanceof ApiRequestError ? err.message : 'The dashboard was not created'),
  });

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="New dashboard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>New dashboard</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="lbl" htmlFor="d-name">What is it called?</label>
            <input id="d-name" className="fld" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="d-desc">What is it for? (optional)</label>
            <input id="d-desc" className="fld" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <p className="hint">
            It starts private. Share it with everyone once the cards are on it.
          </p>
          {error && <p className="modal-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-sm is-primary"
            disabled={name.trim() === '' || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create dashboard'}
          </button>
        </div>
      </div>
    </div>
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
  errorNote = 'Could not count these — is the Visit Type field in the catalogue?',
}: {
  label: string;
  count: number | null | undefined;
  loading: boolean;
  to: string;
  allClearNote: string;
  /** What to say when the count failed; defaults to the Visit Type card's reason. */
  errorNote?: string;
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
          {count === null ? errorNote : allClearNote}
        </div>
      )}
    </Link>
  );
}
