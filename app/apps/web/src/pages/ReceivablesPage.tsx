import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { listWorkOrders } from '../api/client';
import {
  buildCheckLines,
  computeAuditIssues,
  deriveReceivables,
  invoiceAmount,
  invoiceNoFor,
  overallStatus,
  summarizeIssues,
} from '../lib/receivables';
import type {
  AuditChecks,
  AuditIssue,
  AuditRow,
  AuditStatus,
  AuditSummary,
  CheckOutcome,
  InvoiceRow,
  InvoiceStage,
} from '../lib/receivables';

/**
 * Receivables — the AR tab. Two subtabs, one pipeline:
 *
 *   Audit      the Grey Flag queue (ported from the Support Automation shadow
 *              audit assistant): every done-but-unreleased WO, the rules
 *              engine's findings, and the four release checkboxes.
 *   Invoicing  what the audit feeds: clean + gate-ticked WOs surface as
 *              "Ready to invoice", then move Sent → Paid.
 *
 * Ticking Admin + Quote on a clean WO in Audit makes it appear under
 * Invoicing → Ready. The two subtabs are two windows on the same derivation.
 */

type SubTab = 'audit' | 'invoicing';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export function ReceivablesPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab: SubTab = tab === 'invoicing' ? 'invoicing' : 'audit';

  const woQuery = useQuery({
    queryKey: ['work-orders', { limit: 200 }],
    queryFn: () => listWorkOrders({ limit: 200 }),
  });
  const items = useMemo(() => woQuery.data?.items ?? [], [woQuery.data]);

  // The user's toggle state overlays the seeded defaults. Kept at page level so
  // a tick survives switching subtabs (and is what promotes a WO to "Ready").
  const [checkOverrides, setCheckOverrides] = useState<Record<string, Partial<AuditChecks>>>({});
  // Prototype-local lifecycle: Generate invoice → invoiced, Mark paid → paid.
  const [stageOverrides, setStageOverrides] = useState<Record<string, InvoiceStage>>({});

  const { queue, history } = useMemo(() => deriveReceivables(items), [items]);

  const audited: AuditedRow[] = useMemo(
    () =>
      queue.map((row) => {
        const checks = { ...row.checks, ...checkOverrides[row.wo.id] };
        const issues = computeAuditIssues(row, checks);
        return { row, checks, issues, summary: summarizeIssues(issues), status: overallStatus(issues) };
      }),
    [queue, checkOverrides],
  );

  // Released = clean audit AND both gate boxes ticked → the Ready lane.
  const invoiceRows: InvoiceRow[] = useMemo(() => {
    const ready = audited
      .filter((a) => a.status === 'clean' && a.checks.admin && a.checks.quote)
      .map((a) => ({
        wo: a.row.wo,
        stage: stageOverrides[a.row.wo.id] ?? ('ready' as const),
        amount: invoiceAmount(a.row.wo),
        invoiceNo: invoiceNoFor(a.row.wo),
        agedDays: 0,
      }));
    const past = history.map((h) => ({ ...h, stage: stageOverrides[h.wo.id] ?? h.stage }));
    return [...ready, ...past];
  }, [audited, history, stageOverrides]);

  const blockedCount = audited.length - invoiceRows.filter((r) => r.stage === 'ready').length;

  function setCheck(id: string, key: keyof AuditChecks, value: boolean) {
    setCheckOverrides((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  }

  return (
    <AppShell total={woQuery.data?.total} active="Receivables">
      <div className="page-head">
        <h1 className="page-title">Receivables</h1>
        <p className="page-sub">
          Accounts receivable — completion audit and client invoicing, one pipeline.
        </p>
      </div>

      <div className="seg rcv-subtabs" role="tablist" aria-label="Receivables sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'audit'}
          className={`seg-btn${activeTab === 'audit' ? ' is-on' : ''}`}
          onClick={() => navigate('/receivables')}
        >
          <Icon name="flag" size={12} />
          Audit
          <span className="rcv-tab-count">{woQuery.isLoading ? '—' : audited.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'invoicing'}
          className={`seg-btn${activeTab === 'invoicing' ? ' is-on' : ''}`}
          onClick={() => navigate('/receivables/invoicing')}
        >
          <Icon name="dollar" size={12} />
          Invoicing
          <span className="rcv-tab-count">
            {woQuery.isLoading ? '—' : invoiceRows.filter((r) => r.stage !== 'paid').length}
          </span>
        </button>
      </div>

      {activeTab === 'audit' ? (
        <AuditTab
          rows={audited}
          loading={woQuery.isLoading}
          error={woQuery.isError}
          onCheck={setCheck}
        />
      ) : (
        <InvoicingTab
          rows={invoiceRows}
          blockedCount={blockedCount}
          loading={woQuery.isLoading}
          error={woQuery.isError}
          onAdvance={(id, next) => setStageOverrides((prev) => ({ ...prev, [id]: next }))}
        />
      )}
    </AppShell>
  );
}

interface AuditedRow {
  row: AuditRow;
  checks: AuditChecks;
  issues: AuditIssue[];
  summary: AuditSummary;
  status: AuditStatus;
}

// ═══ Audit subtab — the Grey Flag queue ═════════════════════════════════════

type StatusFilter = 'all' | AuditStatus;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'major', label: 'Major' },
  { key: 'minor', label: 'Minor' },
  { key: 'clean', label: 'Clean' },
];

function AuditTab({
  rows,
  loading,
  error,
  onCheck,
}: {
  rows: AuditedRow[];
  loading: boolean;
  error: boolean;
  onCheck: (id: string, key: keyof AuditChecks, value: boolean) => void;
}) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const totals = {
    all: rows.length,
    major: rows.filter((r) => r.status === 'major').length,
    minor: rows.filter((r) => r.status === 'minor').length,
    clean: rows.filter((r) => r.status === 'clean').length,
  };

  const visible = rows.filter((r) => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return (
        r.row.wo.wo_number.toLowerCase().includes(q) ||
        (r.row.wo.client ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const COLS = 12;

  return (
    <>
      <p className="rcv-lede">
        Work orders flagged Low (Grey) — done in the field, pending completion audit. Every check
        below runs automatically; click a row to inspect the evidence.
      </p>

      <div className="rcv-stats">
        <StatCard label="Total in queue" value={loading ? '—' : totals.all} tone="neutral" />
        <StatCard label="Major issues" value={loading ? '—' : totals.major} tone="major" />
        <StatCard label="Minor issues" value={loading ? '—' : totals.minor} tone="minor" />
        <StatCard label="Clean" value={loading ? '—' : totals.clean} tone="clean" />
      </div>

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Filter by audit status">
          {STATUS_FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`seg-btn${filter === f.key ? ' is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="rcv-tab-count">{totals[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="rcv-search">
          <Icon name="search" size={12} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search WO # or client…"
            aria-label="Search the audit queue"
          />
        </div>
      </div>

      <div className="table-wrap">
        <table className="ct rcv-table">
          <thead>
            <tr>
              <th className="col-wo">WO #</th>
              <th>Audit</th>
              <th className="rcv-ck-th">GTG</th>
              <th className="rcv-ck-th">Elise</th>
              <th className="rcv-ck-th">Admin</th>
              <th className="rcv-ck-th">Quote</th>
              <th className="num">Done</th>
              <th className="num">Grey</th>
              <th>FM</th>
              <th>Comp</th>
              <th>CO#</th>
              <th>Assignee</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>Loading the audit queue…</td>
              </tr>
            )}
            {error && !loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>Failed to load work orders. Is the API running on :5174?</td>
              </tr>
            )}
            {!loading && !error && visible.length === 0 && (
              <tr className="ct-empty">
                <td colSpan={COLS}>No work orders match.</td>
              </tr>
            )}
            {!loading &&
              !error &&
              visible.map((r) => (
                <AuditRowPair
                  key={r.row.wo.id}
                  r={r}
                  cols={COLS}
                  open={openId === r.row.wo.id}
                  onToggleOpen={() =>
                    setOpenId((cur) => (cur === r.row.wo.id ? null : r.row.wo.id))
                  }
                  onCheck={onCheck}
                />
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AuditRowPair({
  r,
  cols,
  open,
  onToggleOpen,
  onCheck,
}: {
  r: AuditedRow;
  cols: number;
  open: boolean;
  onToggleOpen: () => void;
  onCheck: (id: string, key: keyof AuditChecks, value: boolean) => void;
}) {
  const { row, checks, summary, status } = r;
  const wo = row.wo;
  return (
    <>
      <tr
        className={`is-clickable rcv-row${open ? ' is-open' : ''}`}
        onClick={onToggleOpen}
        aria-expanded={open}
      >
        <td className="col-wo">
          <div className="rcv-wo-cell">
            <Link
              className="wo-num wo-num-link"
              to={`/work-orders/${encodeURIComponent(wo.wo_number)}`}
              onClick={(e) => e.stopPropagation()}
              title="Open the work order"
            >
              {wo.wo_number}
            </Link>
            {row.bfi && <span className="rcv-bfi" title="Billed For Invoice">BFI</span>}
          </div>
          <small className="rcv-wo-client">{wo.client ?? '—'}</small>
        </td>
        <td>
          <AuditStatusChip status={status} summary={summary} />
        </td>
        {(['gtg', 'elise', 'admin', 'quote'] as const).map((key) => (
          <td key={key} className="rcv-ck-td" onClick={(e) => e.stopPropagation()}>
            <CheckToggle
              on={checks[key]}
              label={`${key} check for ${wo.wo_number}`}
              onToggle={() => onCheck(wo.id, key, !checks[key])}
            />
          </td>
        ))}
        <td className={`num rcv-days${row.daysDone >= 3 ? ' is-hot' : ''}`}>{row.daysDone}d</td>
        <td className={`num rcv-days${row.daysGrey >= 1 ? ' is-hot' : ''}`}>{row.daysGrey}d</td>
        <td className="rcv-trunc">{row.fm}</td>
        <td>
          <span className="rcv-pill">{row.comp}</span>
        </td>
        <td className="rcv-co">{row.coNumber ?? <span className="rcv-none">—</span>}</td>
        <td className="rcv-trunc">{row.assignee}</td>
      </tr>
      {open && (
        <tr className="rcv-detail-tr">
          <td colSpan={cols}>
            <AuditDetail r={r} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The per-WO evidence panel — auto-check read-out, findings, recommendation. */
function AuditDetail({ r }: { r: AuditedRow }) {
  const lines = buildCheckLines(r.row, r.checks);
  const rec =
    r.summary.major > 0
      ? { cls: 'is-major', text: `Suggested QC: Major — ${r.summary.major} blocking issue${r.summary.major > 1 ? 's' : ''}` }
      : r.summary.minor > 0
        ? { cls: 'is-minor', text: `Suggested QC: Minor — ${r.summary.minor} flag${r.summary.minor > 1 ? 's' : ''} to tidy` }
        : r.checks.admin && r.checks.quote
          ? { cls: 'is-clean', text: 'Clean release — this WO is in Invoicing → Ready to invoice' }
          : { cls: 'is-clean', text: 'Clean — tick Admin + Quote to release it to invoicing' };

  const findings = r.issues.filter((i) => i.severity !== 'info');

  return (
    <div className="rcv-detail">
      <section className="rcv-checklist" aria-label="Auto-check results">
        <h3 className="rcv-detail-h">Auto-check results</h3>
        <ul>
          {lines.map((line) => (
            <li key={line.label} className={`rcv-check-line is-${line.outcome}`}>
              <OutcomeMark outcome={line.outcome} />
              <span className="rcv-check-label">{line.label}</span>
              <span className="rcv-check-detail">{line.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rcv-findings" aria-label="Findings">
        <h3 className="rcv-detail-h">
          Findings
          <span className="rcv-detail-hn">{findings.length}</span>
        </h3>
        {findings.length === 0 ? (
          <div className="rcv-nofinding">
            <Icon name="check-circle" size={14} />
            Nothing unresolved — every deterministic check passed.
          </div>
        ) : (
          findings.map((issue) => <IssueCard key={issue.id} issue={issue} woNumber={r.row.wo.wo_number} />)
        )}
        <div className={`rcv-rec ${rec.cls}`}>
          <Icon name={r.summary.major > 0 ? 'alert' : r.summary.minor > 0 ? 'info' : 'check-circle'} size={14} />
          {rec.text}
        </div>
      </section>
    </div>
  );
}

function IssueCard({ issue, woNumber }: { issue: AuditIssue; woNumber: string }) {
  return (
    <article className={`rcv-issue is-${issue.severity}`}>
      <div className="rcv-issue-top">
        <span className={`rcv-sev is-${issue.severity}`}>{issue.severity}</span>
        <h4>{issue.title}</h4>
      </div>
      <p>{issue.description}</p>
      {issue.resolve.length > 0 && (
        <div className="rcv-resolve">
          <span className="rcv-resolve-lbl">Resolve via</span>
          {issue.resolve.map((l) =>
            l.kind === 'wo' ? (
              <Link
                key={l.label}
                className="rcv-chip is-wo"
                to={`/work-orders/${encodeURIComponent(woNumber)}`}
              >
                <Icon name="clipboard" size={12} />
                {l.label}
              </Link>
            ) : (
              <span
                key={l.label}
                className={`rcv-chip is-${l.kind}`}
                title="External systems are stubbed in this prototype"
              >
                <Icon name={l.kind === 'sharepoint' ? 'clip' : 'ext'} size={12} />
                {l.label}
              </span>
            ),
          )}
        </div>
      )}
    </article>
  );
}

function OutcomeMark({ outcome }: { outcome: CheckOutcome }) {
  if (outcome === 'pass') return <Icon name="check" size={12} className="rcv-mark" />;
  if (outcome === 'major') return <Icon name="x" size={12} className="rcv-mark" />;
  if (outcome === 'minor' || outcome === 'info')
    return <Icon name="alert" size={12} className="rcv-mark" />;
  return <span className="rcv-mark rcv-mark-dash" aria-hidden="true">—</span>;
}

function AuditStatusChip({ status, summary }: { status: AuditStatus; summary: AuditSummary }) {
  const label =
    status === 'clean'
      ? 'Clean'
      : status === 'minor'
        ? `${summary.minor} minor`
        : `${summary.major} major`;
  const extra =
    status === 'major' && summary.minor > 0
      ? ` · ${summary.minor} minor`
      : summary.offline > 0
        ? ' · offline'
        : '';
  return (
    <span className={`rcv-status is-${status}`}>
      <span className="rcv-status-dot" aria-hidden="true" />
      {label}
      {extra && <span className="rcv-status-extra">{extra}</span>}
    </span>
  );
}

/** The green audit checkbox — filled when ticked, hollow when not. */
function CheckToggle({
  on,
  label,
  onToggle,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      className={`rcv-ck${on ? ' is-on' : ''}`}
      onClick={onToggle}
    >
      {on && <Icon name="check" size={12} />}
    </button>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'neutral' | 'major' | 'minor' | 'clean';
}) {
  return (
    <div className={`rcv-stat is-${tone}`}>
      <span className="rcv-stat-label">
        <span className="rcv-stat-dot" aria-hidden="true" />
        {label}
      </span>
      <span className="rcv-stat-value">{value}</span>
    </div>
  );
}

// ═══ Invoicing subtab — downstream of the audit ═════════════════════════════

type StageFilter = 'all' | InvoiceStage;

const STAGE_FILTERS: { key: StageFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ready', label: 'Ready' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'paid', label: 'Paid' },
];

const STAGE_LABEL: Record<InvoiceStage, string> = {
  ready: 'Ready to invoice',
  invoiced: 'Invoiced — awaiting payment',
  paid: 'Paid',
};

function InvoicingTab({
  rows,
  blockedCount,
  loading,
  error,
  onAdvance,
}: {
  rows: InvoiceRow[];
  blockedCount: number;
  loading: boolean;
  error: boolean;
  onAdvance: (id: string, next: InvoiceStage) => void;
}) {
  const [filter, setFilter] = useState<StageFilter>('all');

  const ready = rows.filter((r) => r.stage === 'ready');
  const invoiced = rows.filter((r) => r.stage === 'invoiced');
  const paid = rows.filter((r) => r.stage === 'paid');
  const outstanding = invoiced.reduce((sum, r) => sum + r.amount, 0);
  const collected = paid.reduce((sum, r) => sum + r.amount, 0);

  const visible = filter === 'all' ? rows : rows.filter((r) => r.stage === filter);
  const COLS = 7;

  return (
    <>
      <p className="rcv-lede">
        Everything the audit released, staged to cash. A work order lands here the moment its audit
        is clean and both release checks are ticked.
      </p>

      <div className="rcv-stats">
        <StatCard label="Ready to invoice" value={loading ? '—' : ready.length} tone="clean" />
        <StatCard label="Awaiting payment" value={loading ? '—' : invoiced.length} tone="minor" />
        <StatCard label="Outstanding" value={loading ? '—' : money(outstanding)} tone="major" />
        <StatCard label="Collected (30d)" value={loading ? '—' : money(collected)} tone="neutral" />
      </div>

      {blockedCount > 0 && !loading && (
        <div className="rcv-blocked">
          <Icon name="flag" size={12} />
          {blockedCount} work order{blockedCount === 1 ? ' is' : 's are'} still held by the
          completion audit —{' '}
          <Link to="/receivables" className="rcv-blocked-link">
            clear them in the Audit tab
          </Link>
          .
        </div>
      )}

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Filter by invoice stage">
          {STAGE_FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`seg-btn${filter === f.key ? ' is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="rcv-tab-count">
                {f.key === 'all' ? rows.length : rows.filter((r) => r.stage === f.key).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        <table className="ct rcv-table">
          <thead>
            <tr>
              <th className="col-wo">WO #</th>
              <th>Client / Site</th>
              <th>Billing entity</th>
              <th>Invoice</th>
              <th className="num">Amount</th>
              <th>Stage</th>
              <th className="rcv-action-th">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>Loading the invoicing pipeline…</td>
              </tr>
            )}
            {error && !loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>Failed to load work orders. Is the API running on :5174?</td>
              </tr>
            )}
            {!loading && !error && visible.length === 0 && (
              <tr className="ct-empty">
                <td colSpan={COLS}>
                  {filter === 'ready' || filter === 'all'
                    ? 'Nothing is ready yet — clean WOs with Admin + Quote ticked appear here.'
                    : 'Nothing in this stage.'}
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              visible.map((r) => (
                <tr key={r.wo.id}>
                  <td className="col-wo">
                    <Link
                      className="wo-num wo-num-link"
                      to={`/work-orders/${encodeURIComponent(r.wo.wo_number)}`}
                    >
                      {r.wo.wo_number}
                    </Link>
                  </td>
                  <td>
                    <div className="site">
                      <strong>{r.wo.client ?? '—'}</strong>
                      <small>
                        {[r.wo.city, r.wo.state].filter(Boolean).join(', ') || '—'}
                      </small>
                    </div>
                  </td>
                  <td className="rcv-trunc">{r.wo.billing_entity ?? r.wo.client ?? '—'}</td>
                  <td className="rcv-co">
                    {r.stage === 'ready' ? <span className="rcv-none">—</span> : r.invoiceNo}
                  </td>
                  <td className="num rcv-amount">{money(r.amount)}</td>
                  <td>
                    <span className={`rcv-stage is-${r.stage}`}>
                      <span className="rcv-status-dot" aria-hidden="true" />
                      {STAGE_LABEL[r.stage]}
                      {r.stage === 'invoiced' && (
                        <span className="rcv-status-extra"> · {r.agedDays}d</span>
                      )}
                    </span>
                  </td>
                  <td className="rcv-action-td">
                    {r.stage === 'ready' ? (
                      <button
                        type="button"
                        className="rcv-btn is-primary"
                        onClick={() => onAdvance(r.wo.id, 'invoiced')}
                      >
                        <Icon name="send" size={12} />
                        Generate invoice
                      </button>
                    ) : r.stage === 'invoiced' ? (
                      <button
                        type="button"
                        className="rcv-btn"
                        onClick={() => onAdvance(r.wo.id, 'paid')}
                      >
                        <Icon name="check" size={12} />
                        Mark paid
                      </button>
                    ) : (
                      <span className="rcv-paid-mark">
                        <Icon name="check-circle" size={12} />
                        Settled
                      </span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
